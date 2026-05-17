const mongoose = require('mongoose');
const Supplier = require('../models/Supplier');
const PurchaseProduct = require('../models/PurchaseProduct');
const PurchaseOrder = require('../models/PurchaseOrder');

function normalizeInternationalPhone(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const compact = text.replace(/[\\s().-]/g, '');
  const normalized = compact.startsWith('00') ? "+" + compact.slice(2) : compact;
  const hasPlus = normalized.startsWith('+');
  const digits = normalized.replace(/\\D/g, '');

  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    return "+" + digits;
  }

  if (digits.length === 9) return "+34" + digits;
  if (digits.length >= 8 && digits.length <= 15) return "+" + digits;
  return null;
}

function normalizeDay(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function listProducts(req, res) {
  try {
    const supplierId = req.query.supplierId;
    const filter = { businessId: req.businessId };
    if (supplierId) {
      if (!mongoose.Types.ObjectId.isValid(supplierId)) return res.status(400).json({ message: 'Proveedor invalido' });
      filter.supplierId = supplierId;
    }

    const products = await PurchaseProduct.find(filter)
      .populate('supplierId', 'name isActive')
      .sort({ name: 1 })
      .lean();

    res.json(products.map((product) => ({
      ...product,
      supplier: product.supplierId
        ? { _id: product.supplierId._id, name: product.supplierId.name, isActive: product.supplierId.isActive }
        : null,
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function createProduct(req, res) {
  try {
    const { supplierId, name, unit, defaultUnitCost, sku, notes } = req.body;
    if (!mongoose.Types.ObjectId.isValid(supplierId)) return res.status(400).json({ message: 'Proveedor invalido' });
    if (!name?.trim()) return res.status(400).json({ message: 'El nombre es obligatorio' });

    const supplier = await Supplier.findOne({ _id: supplierId, businessId: req.businessId }).lean();
    if (!supplier) return res.status(404).json({ message: 'Proveedor no encontrado' });

    const product = await PurchaseProduct.create({
      businessId: req.businessId,
      supplierId,
      name: name.trim(),
      unit: String(unit || '').trim(),
      defaultUnitCost: Number(defaultUnitCost || 0),
      sku: String(sku || '').trim(),
      notes: String(notes || '').trim(),
    });

    const saved = await PurchaseProduct.findById(product._id).populate('supplierId', 'name isActive').lean();
    res.status(201).json({
      ...saved,
      supplier: saved.supplierId
        ? { _id: saved.supplierId._id, name: saved.supplierId.name, isActive: saved.supplierId.isActive }
        : null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function updateProduct(req, res) {
  try {
    const product = await PurchaseProduct.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });

    const { supplierId, name, unit, defaultUnitCost, sku, notes, isActive } = req.body;

    if (supplierId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(supplierId)) return res.status(400).json({ message: 'Proveedor invalido' });
      const supplier = await Supplier.findOne({ _id: supplierId, businessId: req.businessId }).lean();
      if (!supplier) return res.status(404).json({ message: 'Proveedor no encontrado' });
      product.supplierId = supplierId;
    }
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ message: 'El nombre es obligatorio' });
      product.name = trimmed;
    }
    if (unit !== undefined) product.unit = String(unit).trim();
    if (defaultUnitCost !== undefined) product.defaultUnitCost = Number(defaultUnitCost || 0);
    if (sku !== undefined) product.sku = String(sku).trim();
    if (notes !== undefined) product.notes = String(notes).trim();
    if (isActive !== undefined) product.isActive = Boolean(isActive);

    await product.save();

    const saved = await PurchaseProduct.findById(product._id).populate('supplierId', 'name isActive').lean();
    res.json({
      ...saved,
      supplier: saved.supplierId
        ? { _id: saved.supplierId._id, name: saved.supplierId.name, isActive: saved.supplierId.isActive }
        : null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function listOrders(req, res) {
  try {
    const orders = await PurchaseOrder.find({ businessId: req.businessId })
      .sort({ orderDate: -1, createdAt: -1 })
      .limit(500)
      .lean();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function buildOrderPayload(req, existingOrder = null) {
  const supplierId = req.body.supplierId ?? existingOrder?.supplierId;
  if (!mongoose.Types.ObjectId.isValid(supplierId)) {
    return { error: { status: 400, message: 'Proveedor invalido' } };
  }

  const supplier = await Supplier.findOne({ _id: supplierId, businessId: req.businessId }).lean();
  if (!supplier) return { error: { status: 404, message: 'Proveedor no encontrado' } };

  const rawItems = Array.isArray(req.body.items) ? req.body.items : existingOrder?.items || [];
  const validItems = rawItems.filter((item) => Number(item?.quantity || 0) > 0);
  if (!validItems.length) return { error: { status: 400, message: 'Debes indicar al menos un producto con cantidad' } };

  const productIds = validItems.map((item) => String(item.productId || '')).filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (productIds.length !== validItems.length) return { error: { status: 400, message: 'Hay productos invalidos en el pedido' } };

  const products = await PurchaseProduct.find({
    _id: { $in: productIds },
    businessId: req.businessId,
    supplierId,
  }).lean();

  if (products.length !== productIds.length) {
    return { error: { status: 400, message: 'Todos los productos deben pertenecer al proveedor seleccionado' } };
  }

  const byId = new Map(products.map((product) => [String(product._id), product]));
  const items = validItems.map((item) => {
    const product = byId.get(String(item.productId));
    const quantity = Number(item.quantity || 0);
    const explicitUnitCost = item.unitCost !== undefined && item.unitCost !== null && item.unitCost !== '';
    const unitCost = explicitUnitCost ? Number(item.unitCost) : Number(product.defaultUnitCost || 0);
    const lineTotal = Number((quantity * unitCost).toFixed(2));

    return {
      productId: product._id,
      productName: product.name,
      quantity,
      unit: product.unit || '',
      unitCost,
      lineTotal,
    };
  });

  const totalAmount = Number(items.reduce((acc, item) => acc + item.lineTotal, 0).toFixed(2));
  const orderDate = normalizeDay(req.body.orderDate ?? existingOrder?.orderDate ?? new Date());
  if (!orderDate) return { error: { status: 400, message: 'Fecha de pedido invalida' } };

  return {
    payload: {
      supplierId,
      supplierName: supplier.name,
      orderDate,
      notes: String(req.body.notes ?? existingOrder?.notes ?? '').trim(),
      status: req.body.status || existingOrder?.status || 'draft',
      items,
      totalAmount,
    },
  };
}

async function createOrder(req, res) {
  try {
    const built = await buildOrderPayload(req);
    if (built.error) return res.status(built.error.status).json({ message: built.error.message });

    const order = await PurchaseOrder.create({
      businessId: req.businessId,
      ...built.payload,
    });

    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function updateOrder(req, res) {
  try {
    const order = await PurchaseOrder.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });

    const built = await buildOrderPayload(req, order);
    if (built.error) return res.status(built.error.status).json({ message: built.error.message });

    order.supplierId = built.payload.supplierId;
    order.supplierName = built.payload.supplierName;
    order.orderDate = built.payload.orderDate;
    order.notes = built.payload.notes;
    order.status = built.payload.status;
    order.items = built.payload.items;
    order.totalAmount = built.payload.totalAmount;
    await order.save();

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function markWhatsappSent(req, res) {
  try {
    const order = await PurchaseOrder.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });

    if (!Array.isArray(order.items) || order.items.length === 0) {
      return res.status(400).json({ message: 'El pedido no tiene productos' });
    }

    const supplier = await Supplier.findOne({ _id: order.supplierId, businessId: req.businessId }).lean();
    if (!supplier) return res.status(404).json({ message: 'Proveedor no encontrado' });

    const phone = normalizeInternationalPhone(supplier.whatsappPhone || supplier.phone);
    if (!phone) {
      return res.status(400).json({ message: 'Este proveedor no tiene telefono de WhatsApp configurado' });
    }

    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ message: 'Mensaje de WhatsApp obligatorio' });

    order.whatsappMessageSnapshot = message;
    order.sendMethod = 'manual_whatsapp';
    order.status = 'sent';
    order.sentAt = new Date();
    await order.save();

    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

module.exports = {
  listProducts,
  createProduct,
  updateProduct,
  listOrders,
  createOrder,
  updateOrder,
  markWhatsappSent,
};



