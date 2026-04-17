const Supplier = require('../models/Supplier');
const Expense = require('../models/Expense');

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
    const { name, category, contactName, phone, email, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'El nombre es obligatorio' });

    const supplier = await Supplier.create({
      businessId: req.businessId,
      name: name.trim(),
      category: category || 'other',
      contactName: contactName || '',
      phone: phone || '',
      email: email || '',
      notes: notes || '',
    });
    res.status(201).json(supplier);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function updateSupplier(req, res) {
  try {
    const supplier = await Supplier.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!supplier) return res.status(404).json({ message: 'Proveedor no encontrado' });

    const { name, category, contactName, phone, email, notes, isActive } = req.body;
    if (name !== undefined) supplier.name = name.trim();
    if (category !== undefined) supplier.category = category;
    if (contactName !== undefined) supplier.contactName = contactName;
    if (phone !== undefined) supplier.phone = phone;
    if (email !== undefined) supplier.email = email;
    if (notes !== undefined) supplier.notes = notes;
    if (isActive !== undefined) supplier.isActive = isActive;

    await supplier.save();
    res.json(supplier);
  } catch (err) {
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

module.exports = { getSuppliers, createSupplier, updateSupplier, getSupplierExpenses };
