/**
 * Compares what an invoice bills with what its delivery notes say arrived. Pure.
 * Lines are matched by ingredient when they are linked, otherwise by their description.
 */
const { lineKey } = require('./ingredientParse');

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const keyOf = (it) => (it.ingredientId ? `i:${it.ingredientId}` : `k:${lineKey(it.description)}`);

/** Quantity in the unit of the ingredient (kg, l, ud) when it is known, else as printed. */
const qtyOf = (it) => (it.quantity === null || it.quantity === undefined ? null : it.quantity * (it.content > 0 ? it.content : 1));
/** Price of one unit of that quantity, discount applied. */
const priceOf = (it) => {
  if (it.unitPrice === null || it.unitPrice === undefined) return null;
  return (it.unitPrice * (1 - (it.discount || 0) / 100)) / (it.content > 0 ? it.content : 1);
};

function group(items) {
  const map = new Map();
  for (const it of items) {
    const k = keyOf(it);
    const g = map.get(k) || { key: k, name: it.description, qty: 0, hasQty: false, total: 0, hasTotal: false, price: null };
    const q = qtyOf(it);
    if (q !== null) { g.qty += q; g.hasQty = true; }
    if (it.total !== null && it.total !== undefined) { g.total += it.total; g.hasTotal = true; }
    const p = priceOf(it);
    if (p !== null) g.price = p;
    map.set(k, g);
  }
  return map;
}

function reconcile({ invoiceItems, noteItems, invoiceBase = null, noteTotals = [] }) {
  const billed = group(invoiceItems);
  const delivered = group(noteItems);
  const lines = [];
  for (const [key, b] of billed) {
    const d = delivered.get(key) || null;
    const line = { key, name: b.name, billedQty: b.hasQty ? round(b.qty, 3) : null, deliveredQty: d?.hasQty ? round(d.qty, 3) : null,
      billedPrice: b.price === null ? null : round(b.price, 4), deliveredPrice: d?.price === null || !d ? null : round(d.price, 4), issue: null };
    if (!d) line.issue = 'not-delivered';
    else if (b.hasQty && d.hasQty && b.qty > d.qty * 1.01 + 1e-9) line.issue = 'more-billed';
    else if (b.hasQty && d.hasQty && b.qty < d.qty * 0.99 - 1e-9) line.issue = 'less-billed';
    else if (b.price !== null && d.price !== null && d.price > 0 && Math.abs(b.price - d.price) / d.price > 0.01) line.issue = 'price';
    lines.push(line);
  }
  for (const [key, d] of delivered) {
    if (!billed.has(key)) lines.push({ key, name: d.name, billedQty: null, deliveredQty: d.hasQty ? round(d.qty, 3) : null, billedPrice: null, deliveredPrice: d.price === null ? null : round(d.price, 4), issue: 'not-billed' });
  }
  const known = noteTotals.filter((t) => t !== null && t !== undefined);
  const deliveredBase = known.length === noteTotals.length && known.length ? round(known.reduce((a, b) => a + b, 0)) : null;
  const diff = invoiceBase !== null && deliveredBase !== null ? round(invoiceBase - deliveredBase) : null;
  return {
    lines,
    issues: lines.filter((l) => l.issue).length,
    invoiceBase, deliveredBase, difference: diff !== null && Math.abs(diff) >= 0.05 ? diff : (diff === null ? null : 0),
  };
}

module.exports = { reconcile };
