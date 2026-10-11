const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const InvoiceItem = require('../models/InvoiceItem');
const Supplier = require('../models/Supplier');
const { InvoiceExtractionService } = require('../services/invoiceExtractionService');
const storage = require('../services/invoiceStorage');
const { InvoiceValidationError, normalizeInvoiceExtraction } = require('../lib/invoiceValidation');
const ingredients = require('../services/ingredientSync');
const { reconcile } = require('../lib/reconcile');
const Expense = require('../../finance/models/Expense');
const { syncInvoiceExpense, removeInvoiceExpense, invoiceExpensePayload } = require('../../finance/services/invoiceExpenseSync');

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
  const [invoice, items, financialEntry] = await Promise.all([
    Invoice.findOne({ _id: invoiceId, businessId }).populate('supplierId', 'name taxId isActive').lean(),
    InvoiceItem.find({ invoiceId, businessId }).sort({ position: 1 }).lean(),
    Expense.findOne({ businessId, sourceType: 'INVOICE', sourceId: invoiceId }).select('_id amount expenseDate category').lean(),
  ]);
  return invoice ? { ...serializeInvoice(invoice, items), financialEntry } : null;
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

  const kind = req.body?.kind === 'DELIVERY_NOTE' ? 'DELIVERY_NOTE' : 'INVOICE';
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
      kind,
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
      kind,
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
    await ingredients.safely('link after extraction', () => ingredients.syncInvoice(req.businessId, invoice._id));
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

// Invoices unless delivery notes are asked for: every screen that lists invoices keeps working as before
const kindFilter = (kind) => (kind === 'DELIVERY_NOTE' ? { kind: 'DELIVERY_NOTE' } : { kind: { $ne: 'DELIVERY_NOTE' } });

async function listInvoices(req, res) {
  const filter = { businessId: req.businessId, ...kindFilter(req.query.kind) };
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

    const wasConfirmed = invoice.status === 'CONFIRMED';
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
      status: wasConfirmed ? 'CONFIRMED' : 'REVIEW',
      extractionError: null,
    });
    const isNote = invoice.kind === 'DELIVERY_NOTE';
    let financialSupplier = null;
    if (wasConfirmed && !isNote) {
      financialSupplier = invoice.supplierId
        ? await Supplier.findOne({ _id: invoice.supplierId, businessId: req.businessId }).lean()
        : null;
      invoiceExpensePayload(invoice, financialSupplier);
    }
    if (req.body.items !== undefined) {
      await InvoiceItem.deleteMany({ invoiceId: invoice._id, businessId: req.businessId });
      await InvoiceItem.insertMany(itemDocuments(req.businessId, invoice._id, data.items));
    }
    await invoice.save();
    if (wasConfirmed && !isNote) {
      await syncInvoiceExpense(invoice, financialSupplier);
    }
    await ingredients.safely('sync after edit', () => ingredients.syncInvoice(req.businessId, invoice._id));
    return res.json(await completeInvoice(invoice._id, req.businessId));
  } catch (err) {
    if (err instanceof InvoiceValidationError) return res.status(400).json({ message: err.message });
    if (err.code === 'INVALID_INVOICE_EXPENSE') return res.status(422).json({ message: err.message });
    throw err;
  }
}

async function confirmInvoice(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Factura no encontrada' });
  const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.businessId });
  if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
  if (!['REVIEW', 'CONFIRMED'].includes(invoice.status)) return res.status(409).json({ message: 'Solo se pueden confirmar facturas en revision' });
  try {
    const supplier = invoice.supplierId
      ? await Supplier.findOne({ _id: invoice.supplierId, businessId: req.businessId }).lean()
      : null;
    invoice.status = 'CONFIRMED';
    const isNote = invoice.kind === 'DELIVERY_NOTE';
    if (!isNote) invoiceExpensePayload(invoice, supplier);
    if (invoice.isModified('status')) await invoice.save();
    if (!isNote) await syncInvoiceExpense(invoice, supplier);
  } catch (err) {
    if (err.code === 'INVALID_INVOICE_EXPENSE') return res.status(422).json({ message: err.message });
    throw err;
  }
  await ingredients.safely('prices after confirm', () => ingredients.syncInvoice(req.businessId, invoice._id));
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
  await ingredients.safely('prices after delete', () => ingredients.removeInvoice(req.businessId, invoice._id));
  const billed = await Invoice.find({ businessId: req.businessId, billedInvoiceId: invoice._id }).select('_id').lean();
  await Invoice.updateMany({ businessId: req.businessId, billedInvoiceId: invoice._id }, { $set: { billedInvoiceId: null } });
  for (const n of billed) await ingredients.safely('prices of freed note', () => ingredients.syncInvoice(req.businessId, n._id));
  await Promise.all([
    removeInvoiceExpense(invoice),
    InvoiceItem.deleteMany({ invoiceId: invoice._id, businessId: req.businessId }),
    Invoice.deleteOne({ _id: invoice._id, businessId: req.businessId }),
  ]);
  return res.json({ success: true });
}

const noteSummary = (n) => ({ id: n._id, number: n.invoiceNumber, date: n.invoiceDate, status: n.status, total: decimalToNumber(n.total) });

// GET /api/invoices/:id/delivery-notes → the notes already billed by this invoice, the ones that could be, and the comparison
async function deliveryNotes(req, res) {
  const { businessId } = req;
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Factura no encontrada' });
  const invoice = await Invoice.findOne({ _id: req.params.id, businessId, kind: { $ne: 'DELIVERY_NOTE' } }).lean();
  if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
  const [linked, free] = await Promise.all([
    Invoice.find({ businessId, kind: 'DELIVERY_NOTE', billedInvoiceId: invoice._id }).sort({ invoiceDate: 1 }).lean(),
    invoice.supplierId
      ? Invoice.find({ businessId, kind: 'DELIVERY_NOTE', supplierId: invoice.supplierId, billedInvoiceId: null, status: { $ne: 'FAILED' } }).sort({ invoiceDate: -1 }).limit(30).lean()
      : [],
  ]);
  const itemsOf = async (ids) => (ids.length ? InvoiceItem.find({ businessId, invoiceId: { $in: ids } }).lean() : []);
  const [invoiceItems, noteItems] = await Promise.all([itemsOf([invoice._id]), itemsOf(linked.map((n) => n._id))]);
  const comparison = linked.length ? reconcile({ invoiceItems: invoiceItems.map(serializeItem), noteItems: noteItems.map(serializeItem), invoiceBase: decimalToNumber(invoice.subtotal), noteTotals: linked.map((n) => decimalToNumber(n.subtotal ?? n.total)) }) : null;
  return res.json({ linked: linked.map(noteSummary), candidates: free.map(noteSummary), comparison });
}

// PUT /api/invoices/:id/delivery-notes { ids } → exactly these notes are billed by the invoice
async function setDeliveryNotes(req, res) {
  const { businessId } = req;
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Factura no encontrada' });
  const invoice = await Invoice.findOne({ _id: req.params.id, businessId, kind: { $ne: 'DELIVERY_NOTE' } }).select('_id').lean();
  if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const notes = await Invoice.find({ businessId, kind: 'DELIVERY_NOTE', _id: { $in: ids }, $or: [{ billedInvoiceId: null }, { billedInvoiceId: invoice._id }] }).select('_id').lean();
  const keep = notes.map((n) => String(n._id));
  const before = await Invoice.find({ businessId, kind: 'DELIVERY_NOTE', billedInvoiceId: invoice._id }).select('_id').lean();
  await Invoice.updateMany({ businessId, kind: 'DELIVERY_NOTE', billedInvoiceId: invoice._id, _id: { $nin: keep } }, { $set: { billedInvoiceId: null } });
  await Invoice.updateMany({ businessId, kind: 'DELIVERY_NOTE', _id: { $in: keep } }, { $set: { billedInvoiceId: invoice._id } });
  // A billed note leaves its prices to the invoice; a freed one gets them back
  const touched = new Set([...keep, ...before.map((n) => String(n._id))]);
  for (const id of touched) await ingredients.safely('prices after linking note', () => ingredients.syncInvoice(businessId, id));
  return deliveryNotes(req, res);
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
  deliveryNotes,
  setDeliveryNotes,
  setExtractionServiceForTests,
  serializeInvoice,
  findOrCreateSupplier,
};
