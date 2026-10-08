/**
 * Keeps the price of every ingredient up to date from the invoices:
 *  - a line of an invoice is linked to an ingredient when its text matches an alias the restaurant taught;
 *  - a confirmed invoice leaves one price per linked line (per kg / l / unit, VAT excluded);
 *  - each ingredient keeps its last price, the one before, the change, the lowest and the highest.
 * A failure here must never break the invoice flow: callers use `safely`.
 */
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const InvoiceItem = require('../models/InvoiceItem');
const Ingredient = require('../models/Ingredient');
const IngredientPrice = require('../models/IngredientPrice');
const { lineKey } = require('../lib/ingredientParse');

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : null;
};
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** Price per kg / l / unit of a line, VAT excluded; null when the line has no usable price. */
function pricePerUnit(item) {
  const unitPrice = num(item.unitPrice);
  const content = Number(item.content);
  if (unitPrice === null || unitPrice < 0 || !(content > 0)) return null;
  const discount = num(item.discount) || 0;
  return round((unitPrice * (1 - discount / 100)) / content);
}

/** Link the lines of an invoice that match what the restaurant already taught. */
async function linkItems(businessId, invoiceId) {
  const items = await InvoiceItem.find({ businessId, invoiceId, ingredientId: null }).select('description').lean();
  if (!items.length) return 0;
  const ingredients = await Ingredient.find({ businessId, 'aliases.0': { $exists: true } }).select('aliases').lean();
  const byKey = new Map();
  for (const ing of ingredients) for (const a of ing.aliases) byKey.set(a.key, { ingredientId: ing._id, content: a.content });
  const ops = [];
  for (const it of items) {
    const hit = byKey.get(lineKey(it.description));
    if (hit) ops.push({ updateOne: { filter: { _id: it._id }, update: { $set: { ingredientId: hit.ingredientId, content: hit.content } } } });
  }
  if (ops.length) await InvoiceItem.bulkWrite(ops, { ordered: false });
  return ops.length;
}

/** The prices of an invoice: none unless it is confirmed; then one per linked line. Returns the affected ingredient ids. */
async function rebuildPrices(businessId, invoiceId) {
  const before = await IngredientPrice.find({ businessId, invoiceId }).select('ingredientId').lean();
  const affected = new Set(before.map((p) => String(p.ingredientId)));
  await IngredientPrice.deleteMany({ businessId, invoiceId });
  const invoice = await Invoice.findOne({ _id: invoiceId, businessId }).select('status invoiceDate supplierId createdAt').lean();
  if (invoice?.status === 'CONFIRMED') {
    const items = await InvoiceItem.find({ businessId, invoiceId, ingredientId: { $ne: null } }).lean();
    const date = invoice.invoiceDate || new Date(invoice.createdAt).toISOString().slice(0, 10);
    const docs = [];
    for (const it of items) {
      const price = pricePerUnit(it);
      if (price === null) continue;
      const qty = num(it.quantity);
      docs.push({ businessId, ingredientId: it.ingredientId, invoiceId, itemId: it._id, supplierId: invoice.supplierId || null, date, price,
        quantity: qty === null ? null : round(qty * Number(it.content), 3), description: it.description });
      affected.add(String(it.ingredientId));
    }
    if (docs.length) await IngredientPrice.insertMany(docs, { ordered: false });
  }
  return [...affected];
}

/** Last price, the one before (another purchase), the change in %, lowest and highest. */
async function recomputeIngredient(businessId, ingredientId) {
  const prices = await IngredientPrice.find({ businessId, ingredientId }).sort({ date: -1, createdAt: -1 }).lean();
  const stats = { lastPrice: null, lastDate: null, lastSupplierId: null, prevPrice: null, prevDate: null, changePct: null, minPrice: null, maxPrice: null, count: prices.length };
  if (prices.length) {
    const last = prices[0];
    // The price before = the latest purchase on an earlier invoice
    const prev = prices.find((p) => String(p.invoiceId) !== String(last.invoiceId));
    stats.lastPrice = last.price; stats.lastDate = last.date; stats.lastSupplierId = last.supplierId || null;
    stats.minPrice = Math.min(...prices.map((p) => p.price));
    stats.maxPrice = Math.max(...prices.map((p) => p.price));
    if (prev) {
      stats.prevPrice = prev.price; stats.prevDate = prev.date;
      stats.changePct = prev.price > 0 ? round(((last.price - prev.price) / prev.price) * 100, 1) : null;
    }
  }
  await Ingredient.updateOne({ _id: ingredientId, businessId }, { $set: { stats } });
  return stats;
}

async function recomputeMany(businessId, ids) {
  for (const id of ids) {
    if (mongoose.isValidObjectId(id)) await recomputeIngredient(businessId, id);
  }
}

/** After an invoice was created, edited, confirmed or deleted. */
async function syncInvoice(businessId, invoiceId) {
  await linkItems(businessId, invoiceId);
  await recomputeMany(businessId, await rebuildPrices(businessId, invoiceId));
}

async function removeInvoice(businessId, invoiceId) {
  const ids = (await IngredientPrice.find({ businessId, invoiceId }).select('ingredientId').lean()).map((p) => String(p.ingredientId));
  await IngredientPrice.deleteMany({ businessId, invoiceId });
  await recomputeMany(businessId, [...new Set(ids)]);
}

/** Never lets this module break the invoice flow. */
async function safely(label, fn) {
  try { return await fn(); } catch (err) { console.error(`[ingredients] ${label} failed:`, err.message); return null; }
}

module.exports = { pricePerUnit, linkItems, rebuildPrices, recomputeIngredient, recomputeMany, syncInvoice, removeInvoice, safely };
