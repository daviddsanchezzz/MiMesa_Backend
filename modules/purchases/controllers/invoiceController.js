const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const InvoiceItem = require('../models/InvoiceItem');
const Supplier = require('../models/Supplier');
const { InvoiceExtractionService } = require('../services/invoiceExtractionService');
const storage = require('../services/invoiceStorage');
const { InvoiceValidationError, normalizeInvoiceExtraction } = require('../lib/invoiceValidation');

let extractionService = new InvoiceExtractionService();

function decimalToNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

function serializeItem(item) {
  const value = typeof item.toObject === 'function' ? item.toObject() : item;
  return {
    ...value,
    packageQuantity: decimalToNumber(value.packageQuantity),
    quantity: decimalToNumber(value.quantity),
    unitPrice: decimalToNumber(value.unitPrice),
    discount: decimalToNumber(value.discount),
    taxRate: decimalToNumber(value.taxRate),
    total: decimalToNumber(value.total),
  };
}

function serializeTaxBreakdown(entries = []) {
  return entries.map((entry) => ({
    taxRate: decimalToNumber(entry.taxRate),
    taxableBase: decimalToNumber(entry.taxableBase),
    taxAmount: decimalToNumber(entry.taxAmount),
  }));
}

function serializeInvoice(invoice, items) {
  const value = typeof invoice.toObject === 'function' ? invoice.toObject() : invoice;
  const populatedSupplier = value.supplierId && typeof value.supplierId === 'object' && value.supplierId.name;
  return {
    ...value,
    supplierId: populatedSupplier ? value.supplierId._id : value.supplierId,
    supplier: populatedSupplier ? value.supplierId : null,
    grossAmount: decimalToNumber(value.grossAmount),
    discountRate: decimalToNumber(value.discountRate),
    discountAmount: decimalToNumber(value.discountAmount),
    shippingAmount: decimalToNumber(value.shippingAmount),
    subtotal: decimalToNumber(value.subtotal),
    taxAmount: decimalToNumber(value.taxAmount),
    total: decimalToNumber(value.total),
    taxBreakdown: serializeTaxBreakdown(value.taxBreakdown),
    ...(items ? { items: items.map(serializeItem) } : {}),
  };
}

async function completeInvoice(invoiceId, businessId) {
  const [invoice, items] = await Promise.all([
    Invoice.findOne({ _id: invoiceId, businessId }).populate('supplierId', 'name taxId isActive').lean(),
    InvoiceItem.find({ invoiceId, businessId }).sort({ position: 1 }).lean(),
  ]);
  return invoice ? serializeInvoice(invoice, items) : null;
}

async function findOrCreateSupplier(businessId, input, { updateExistingName = false } = {}) {
  const name = String(input?.name || '').trim().replace(/\s+/g, ' ');
  const taxId = String(input?.taxId || '').trim() || null;
  const normalizedTaxId = Supplier.normalizeTaxId(taxId);
  const normalizedName = Supplier.normalizeSupplierName(name);
  if (!name && !normalizedTaxId) return null;

  if (normalizedTaxId) {
    let supplier = await Supplier.findOne({ businessId, normalizedTaxId });
    if (supplier) {
      if (updateExistingName && name && supplier.name !== name) {
        supplier.name = name;
        await supplier.save();
      }
      return supplier;
    }
    try {
      return await Supplier.create({ businessId, name: name || taxId, taxId });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      supplier = await Supplier.findOne({ businessId, normalizedTaxId });
      if (supplier) return supplier;
      throw err;
    }
  }

  let supplier = await Supplier.findOne({ businessId, normalizedName });
  if (!supplier && name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    supplier = await Supplier.findOne({ businessId, name: new RegExp(`^${escaped}$`, 'i') });
  }
  return supplier || Supplier.create({ businessId, name });
}

function itemDocuments(businessId, invoiceId, items) {
  return items.map((item, position) => ({ businessId, invoiceId, position, ...item }));
}

function safeExtractionError(err) {
  if (err instanceof InvoiceValidationError) return 'Respuesta de extraccion invalida';
  if (err?.name === 'AbortError') return 'Timeout del proveedor de extraccion';
  if (String(err?.message || '').includes('OPENAI_API_KEY')) return 'Proveedor de extraccion no configurado';
  return 'Fallo del proveedor de extraccion';
}

function matchesFileSignature(file) {
  const b = file?.buffer;
  if (!Buffer.isBuffer(b) || !b.length) return false;
  if (file.mimetype === 'application/pdf') return b.subarray(0, 5).toString() === '%PDF-';
  if (file.mimetype === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (file.mimetype === 'image/png') return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (file.mimetype === 'image/webp') return b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
  return false;
}

async function extractInvoice(req, res) {
  if (!req.file) return res.status(400).json({ message: 'Debes adjuntar una factura en file' });
  if (!matchesFileSignature(req.file)) return res.status(400).json({ message: 'El contenido del archivo no coincide con un PDF o imagen valida' });

  const invoiceId = new mongoose.Types.ObjectId();
  let documentKey;
  let invoice;
  try {
    documentKey = await storage.store({
      businessId: req.businessId,
      invoiceId,
      mimeType: req.file.mimetype,
      buffer: req.file.buffer,
    });
    invoice = await Invoice.create({
      _id: invoiceId,
      businessId: req.businessId,
      documentKey,
      documentUrl: `/api/invoices/${invoiceId}/document`,
      documentMimeType: req.file.mimetype,
      documentOriginalName: req.file.originalname,
      documentSize: req.file.size,
      status: 'PROCESSING',
      createdBy: req.user?.id || null,
    });
  } catch (err) {
    if (!invoice && documentKey) {
      await storage.remove(documentKey).catch((cleanupError) => {
        console.error(`[invoices] upload rollback failed invoice=${invoiceId} business=${req.businessId} code=${cleanupError.code || 'UNKNOWN'}`);
      });
    }
    console.error(`[invoices] failed to persist upload invoice=${invoiceId} business=${req.businessId} code=${err.code || 'UNKNOWN'}`);
    return res.status(500).json({ message: 'No se pudo almacenar la factura' });
  }

  try {
    const extracted = await extractionService.extract({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      originalName: req.file.originalname,
    });
    const supplier = await findOrCreateSupplier(req.businessId, extracted.data.supplier);
    await InvoiceItem.insertMany(itemDocuments(req.businessId, invoice._id, extracted.data.items));
    Object.assign(invoice, {
      supplierId: supplier?._id || null,
      invoiceNumber: extracted.data.invoiceNumber,
      invoiceDate: extracted.data.invoiceDate,
      grossAmount: extracted.data.grossAmount,
      discountRate: extracted.data.discountRate,
      discountAmount: extracted.data.discountAmount,
      shippingAmount: extracted.data.shippingAmount,
      subtotal: extracted.data.subtotal,
      taxAmount: extracted.data.taxAmount,
      total: extracted.data.total,
      taxBreakdown: extracted.data.taxBreakdown,
      currency: extracted.data.currency || 'EUR',
      extractionRaw: extracted.raw,
      extractionWarnings: extracted.warnings,
      extractionError: null,
      status: 'REVIEW',
    });
    await invoice.save();
    return res.status(201).json(await completeInvoice(invoice._id, req.businessId));
  } catch (err) {
    await InvoiceItem.deleteMany({ invoiceId: invoice._id, businessId: req.businessId }).catch(() => {});
    const safeError = safeExtractionError(err);
    await Invoice.updateOne(
      { _id: invoice._id, businessId: req.businessId },
      { $set: { status: 'FAILED', extractionError: safeError } },
    ).catch((updateErr) => console.error('[invoices] failed to mark invoice FAILED:', updateErr.message));
    console.error(`[invoices] extraction failed invoice=${invoice._id} business=${req.businessId}:`, err.message);
    const status = err instanceof InvoiceValidationError ? 422
      : String(err?.message || '').includes('OPENAI_API_KEY') ? 503 : 502;
    return res.status(status).json({
      message: status === 422 ? 'La extraccion devolvio datos no validos' : 'No se pudo extraer la factura',
      code: status === 422 ? 'INVALID_EXTRACTION' : 'EXTRACTION_FAILED',
      invoiceId: invoice._id,
    });
  }
}

async function listInvoices(req, res) {
  const filter = { businessId: req.businessId };
  if (req.query.status) filter.status = String(req.query.status).toUpperCase();
  const invoices = await Invoice.find(filter)
    .populate('supplierId', 'name taxId isActive')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  return res.json(invoices.map((invoice) => serializeInvoice(invoice)));
}

async function getInvoice(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Factura no encontrada' });
  const invoice = await completeInvoice(req.params.id, req.businessId);
  if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
  return res.json(invoice);
}

async function downloadDocument(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Factura no encontrada' });
  const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.businessId }).select('+documentKey').lean();
  if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
  try {
    const access = await storage.access(invoice.documentKey, { expiresIn: 60 });
    if (access.type === 'redirect') {
      res.set('Cache-Control', 'private, no-store');
      return res.json({
        url: access.url,
        expiresIn: access.expiresIn,
        mimeType: invoice.documentMimeType,
        fileName: invoice.documentOriginalName,
      });
    }
    const safeName = String(invoice.documentOriginalName || 'factura').replace(/[\r\n"\\]/g, '_');
    const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_');
    const encodedName = encodeURIComponent(safeName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.set({
      'Content-Type': invoice.documentMimeType,
      'Content-Length': access.size,
      'Content-Disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'private, no-store',
    });
    return access.stream.pipe(res);
  } catch (err) {
    console.error(`[invoices] document access failed invoice=${invoice._id} business=${req.businessId} code=${err.code || 'UNKNOWN'}`);
    if (err.code === 'DOCUMENT_NOT_FOUND') return res.status(404).json({ message: 'Documento no encontrado' });
    return res.status(502).json({ message: 'No se pudo acceder al documento', code: 'DOCUMENT_ACCESS_FAILED' });
  }
}

async function supplierFromPatch(businessId, body, currentId) {
  if (body.supplierId !== undefined) {
    if (body.supplierId === null || body.supplierId === '') return null;
    if (!mongoose.Types.ObjectId.isValid(body.supplierId)) throw new InvoiceValidationError('Proveedor no valido');
    const supplier = await Supplier.findOne({ _id: body.supplierId, businessId });
    if (!supplier) throw new InvoiceValidationError('Proveedor no encontrado');
    return supplier;
  }
  if (body.supplier !== undefined) return findOrCreateSupplier(businessId, body.supplier, { updateExistingName: true });
  return currentId;
}

async function patchInvoice(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Factura no encontrada' });
  const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.businessId });
  if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
  if (invoice.status === 'PROCESSING') return res.status(409).json({ message: 'La factura todavia se esta procesando' });

  const editableFields = [
    'supplierId', 'supplier', 'invoiceNumber', 'invoiceDate', 'currency', 'items',
    'grossAmount', 'discountRate', 'discountAmount', 'shippingAmount',
    'subtotal', 'taxAmount', 'total', 'taxBreakdown',
  ];
  if (!editableFields.some((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field))) {
    return res.status(400).json({ message: 'No hay campos editables en la solicitud' });
  }

  try {
    const existingItems = await InvoiceItem.find({ invoiceId: invoice._id, businessId: req.businessId }).sort({ position: 1 }).lean();
    const merged = {
      supplier: { name: null, taxId: null },
      invoiceNumber: req.body.invoiceNumber !== undefined ? req.body.invoiceNumber : invoice.invoiceNumber,
      invoiceDate: req.body.invoiceDate !== undefined ? req.body.invoiceDate : invoice.invoiceDate,
      currency: req.body.currency !== undefined ? req.body.currency : invoice.currency,
      items: req.body.items !== undefined ? req.body.items : existingItems.map(serializeItem),
      grossAmount: req.body.grossAmount !== undefined ? req.body.grossAmount : decimalToNumber(invoice.grossAmount),
      discountRate: req.body.discountRate !== undefined ? req.body.discountRate : decimalToNumber(invoice.discountRate),
      discountAmount: req.body.discountAmount !== undefined ? req.body.discountAmount : decimalToNumber(invoice.discountAmount),
      shippingAmount: req.body.shippingAmount !== undefined ? req.body.shippingAmount : decimalToNumber(invoice.shippingAmount),
      subtotal: req.body.subtotal !== undefined ? req.body.subtotal : decimalToNumber(invoice.subtotal),
      taxAmount: req.body.taxAmount !== undefined ? req.body.taxAmount : decimalToNumber(invoice.taxAmount),
      total: req.body.total !== undefined ? req.body.total : decimalToNumber(invoice.total),
      taxBreakdown: req.body.taxBreakdown !== undefined ? req.body.taxBreakdown : serializeTaxBreakdown(invoice.taxBreakdown),
    };
    const { data, warnings } = normalizeInvoiceExtraction(merged);
    const supplier = await supplierFromPatch(req.businessId, req.body, invoice.supplierId);

    if (req.body.items !== undefined) {
      await InvoiceItem.deleteMany({ invoiceId: invoice._id, businessId: req.businessId });
      await InvoiceItem.insertMany(itemDocuments(req.businessId, invoice._id, data.items));
    }
    Object.assign(invoice, {
      supplierId: supplier?._id || supplier || null,
      invoiceNumber: data.invoiceNumber,
      invoiceDate: data.invoiceDate,
      currency: data.currency || 'EUR',
      grossAmount: data.grossAmount,
      discountRate: data.discountRate,
      discountAmount: data.discountAmount,
      shippingAmount: data.shippingAmount,
      subtotal: data.subtotal,
      taxAmount: data.taxAmount,
      total: data.total,
      taxBreakdown: data.taxBreakdown,
      extractionWarnings: warnings,
      status: 'REVIEW',
      extractionError: null,
    });
    await invoice.save();
    return res.json(await completeInvoice(invoice._id, req.businessId));
  } catch (err) {
    if (err instanceof InvoiceValidationError) return res.status(400).json({ message: err.message });
    throw err;
  }
}

async function confirmInvoice(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Factura no encontrada' });
  const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.businessId });
  if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
  if (invoice.status !== 'REVIEW') return res.status(409).json({ message: 'Solo se pueden confirmar facturas en revision' });
  invoice.status = 'CONFIRMED';
  await invoice.save();
  return res.json(await completeInvoice(invoice._id, req.businessId));
}

async function deleteInvoice(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Factura no encontrada' });
  const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.businessId }).select('+documentKey');
  if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
  try {
    await storage.remove(invoice.documentKey);
  } catch (err) {
    console.error(`[invoices] document delete failed invoice=${invoice._id} business=${req.businessId} code=${err.code || 'UNKNOWN'}`);
    return res.status(502).json({ message: 'No se pudo eliminar el documento de la factura', code: 'DOCUMENT_DELETE_FAILED' });
  }
  await Promise.all([
    InvoiceItem.deleteMany({ invoiceId: invoice._id, businessId: req.businessId }),
    Invoice.deleteOne({ _id: invoice._id, businessId: req.businessId }),
  ]);
  return res.json({ success: true });
}

function setExtractionServiceForTests(service) {
  extractionService = service || new InvoiceExtractionService();
}

module.exports = {
  extractInvoice,
  listInvoices,
  getInvoice,
  downloadDocument,
  patchInvoice,
  confirmInvoice,
  deleteInvoice,
  setExtractionServiceForTests,
  serializeInvoice,
  findOrCreateSupplier,
};
