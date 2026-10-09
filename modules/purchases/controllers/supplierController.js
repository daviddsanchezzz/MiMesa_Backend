const Supplier = require('../models/Supplier');
const Expense = require('../../finance/models/Expense');
const Invoice = require('../models/Invoice');
const PurchaseProduct = require('../models/PurchaseProduct');
const PurchaseOrder = require('../models/PurchaseOrder');

async function getSuppliers(req, res) {
  try {
    const suppliers = await Supplier.find({ businessId: req.businessId }).sort({ name: 1 }).lean();
    res.json(suppliers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function createSupplier(req, res) {
  try {
    const { name, taxId, category, contactName, phone, whatsappPhone, email, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'El nombre es obligatorio' });

    const supplier = await Supplier.create({
      businessId: req.businessId,
      name: name.trim(),
      taxId: taxId || null,
      category: category || 'other',
      contactName: contactName || '',
      phone: phone || '',
      whatsappPhone: whatsappPhone || '',
      email: email || '',
      notes: notes || '',
    });
    res.status(201).json(supplier);
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ message: 'Ya existe un proveedor con ese NIF/CIF' });
    res.status(500).json({ message: err.message });
  }
}

async function updateSupplier(req, res) {
  try {
    const supplier = await Supplier.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!supplier) return res.status(404).json({ message: 'Proveedor no encontrado' });

    const { name, taxId, category, contactName, phone, whatsappPhone, email, notes, isActive } = req.body;
    if (name !== undefined) supplier.name = name.trim();
    if (taxId !== undefined) supplier.taxId = taxId || null;
    if (category !== undefined) supplier.category = category;
    if (contactName !== undefined) supplier.contactName = contactName;
    if (phone !== undefined) supplier.phone = phone;
    if (whatsappPhone !== undefined) supplier.whatsappPhone = whatsappPhone;
    if (email !== undefined) supplier.email = email;
    if (notes !== undefined) supplier.notes = notes;
    if (isActive !== undefined) supplier.isActive = isActive;

    await supplier.save();
    res.json(supplier);
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ message: 'Ya existe un proveedor con ese NIF/CIF' });
    res.status(500).json({ message: err.message });
  }
}

async function getSupplierExpenses(req, res) {
  try {
    const supplier = await Supplier.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
    if (!supplier) return res.status(404).json({ message: 'Proveedor no encontrado' });

    const expenses = await Expense.find({ businessId: req.businessId, supplierId: req.params.id })
      .sort({ expenseDate: -1 })
      .limit(50)
      .lean();

    const total = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    res.json({ supplier, expenses, total: Number(total.toFixed(2)) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getSupplierDetail(req, res) {
  try {
    const supplier = await Supplier.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
    if (!supplier) return res.status(404).json({ message: 'Proveedor no encontrado' });

    const now = new Date();
    const year = String(now.getFullYear());
    const month = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [invoices, products, orders, monthExpenses, yearExpenses, invoiceCount, orderCount] = await Promise.all([
      Invoice.find({ businessId: req.businessId, supplierId: supplier._id, kind: { $ne: 'DELIVERY_NOTE' } }).sort({ invoiceDate: -1, createdAt: -1 }).limit(50).lean(),
      PurchaseProduct.find({ businessId: req.businessId, supplierId: supplier._id }).sort({ sortOrder: 1, name: 1 }).lean(),
      PurchaseOrder.find({ businessId: req.businessId, supplierId: supplier._id }).sort({ orderDate: -1 }).limit(50).lean(),
      Expense.find({ businessId: req.businessId, supplierId: supplier._id, expenseDate: { $gte: `${month}-01`, $lte: `${month}-31` } }).lean(),
      Expense.find({ businessId: req.businessId, supplierId: supplier._id, expenseDate: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }).lean(),
      Invoice.countDocuments({ businessId: req.businessId, supplierId: supplier._id, kind: { $ne: 'DELIVERY_NOTE' } }),
      PurchaseOrder.countDocuments({ businessId: req.businessId, supplierId: supplier._id }),
    ]);
    const sum = (rows) => Number(rows.reduce((total, row) => total + Number(row.amount || 0), 0).toFixed(2));
    const lastDates = [invoices[0]?.invoiceDate, orders[0]?.orderDate && new Date(orders[0].orderDate).toISOString().slice(0, 10)].filter(Boolean).sort();

    return res.json({
      supplier,
      summary: {
        spendThisMonth: sum(monthExpenses),
        spendThisYear: sum(yearExpenses),
        invoices: invoiceCount,
        products: products.length,
        orders: orderCount,
        lastPurchase: lastDates.at(-1) || null,
      },
      invoices: invoices.map((invoice) => ({
        ...invoice,
        total: invoice.total == null ? null : Number(invoice.total.toString()),
      })),
      products,
      orders,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

module.exports = { getSuppliers, createSupplier, updateSupplier, getSupplierExpenses, getSupplierDetail };
