const mongoose = require('mongoose');
const MenuItem = require('../../menu/models/MenuItem');
const Ingredient = require('../models/Ingredient');
const IngredientPrice = require('../models/IngredientPrice');
const Recipe = require('../models/Recipe');
const SaleLine = require('../models/SaleLine');
const StockCount = require('../models/StockCount');
const WasteEntry = require('../models/WasteEntry');
const { lineKey } = require('../lib/ingredientParse');
const { normalizeSales } = require('../lib/salesRows');
const { theoreticalUse, reconcile } = require('../lib/consumption');

const isId = (id) => mongoose.isValidObjectId(id);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const bad = (res, message, status = 400) => res.status(status).json({ message });
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    console.error('[consumption]', err);
    res.status(500).json({ message: 'Algo ha fallado. Inténtalo de nuevo.' });
  }
};
const today = () => new Date().toISOString().slice(0, 10);
const range = (q) => {
  const to = DATE_RE.test(q.to) ? q.to : today();
  const from = DATE_RE.test(q.from) ? q.from : new Date(new Date(`${to}T12:00:00Z`).getTime() - 29 * 86400000).toISOString().slice(0, 10);
  return { from, to };
};

/** Which dish of the carta each row is: by the code of the till when there is one, else by its name in any language. */
async function matcher(businessId) {
  const items = await MenuItem.find({ businessId, retired: { $ne: true } }).select('name externalId').lean();
  const byCode = new Map();
  const byName = new Map();
  for (const it of items) {
    if (it.externalId) byCode.set(String(it.externalId).trim(), it._id);
    const names = typeof it.name === 'string' ? [it.name] : Object.values(it.name || {});
    for (const n of names) if (n) byName.set(lineKey(n), it._id);
  }
  return (row) => (row.externalId && byCode.get(row.externalId)) || byName.get(lineKey(row.name)) || null;
}

// POST /api/consumption/sales/import { rows: [{ date, name, externalId?, quantity, amount? }] }
exports.importSales = wrap(async (req, res) => {
  const { businessId } = req;
  const { rows, skipped, errors } = normalizeSales(req.body?.rows);
  if (!rows.length) return bad(res, errors[0]?.message || 'No hay nada que importar');
  const find = await matcher(businessId);
  const docs = rows.map((r) => ({ businessId, date: r.date, key: r.key, itemId: find(r) || null, externalId: r.externalId, name: r.name, quantity: r.quantity, amount: r.amount, source: 'import' }));
  // Importing a day again replaces what an earlier file said about it
  const dates = [...new Set(docs.map((d) => d.date))];
  await SaleLine.deleteMany({ businessId, date: { $in: dates }, source: 'import' });
  await SaleLine.insertMany(docs, { ordered: false });
  const unmatched = new Map();
  for (const d of docs) if (!d.itemId) unmatched.set(d.key, { name: d.name || d.externalId, units: (unmatched.get(d.key)?.units || 0) + d.quantity });
  res.json({
    days: dates.length, from: dates.slice().sort()[0], to: dates.slice().sort().pop(),
    lines: docs.length, units: Math.round(docs.reduce((n, d) => n + d.quantity, 0) * 100) / 100,
    matched: docs.filter((d) => d.itemId).length, skipped, errors: errors.slice(0, 20),
    unmatched: [...unmatched.values()].sort((a, b) => b.units - a.units).slice(0, 30),
  });
});

// GET /api/consumption/report?from&to → what should have been used against what came in
exports.report = wrap(async (req, res) => {
  const { businessId } = req;
  const { from, to } = range(req.query);
  const [sales, recipes, prices, wastes, ingredients, counts] = await Promise.all([
    SaleLine.find({ businessId, date: { $gte: from, $lte: to } }).lean(),
    Recipe.find({ businessId }).lean(),
    IngredientPrice.find({ businessId, date: { $gte: from, $lte: to }, quantity: { $ne: null } }).select('ingredientId quantity').lean(),
    WasteEntry.find({ businessId, date: { $gte: from, $lte: to } }).select('ingredientId quantity cost').lean(),
    Ingredient.find({ businessId }).select('name unit stats').lean(),
    StockCount.find({ businessId, date: { $lte: to } }).sort({ date: -1 }).limit(60).lean(),
  ]);
  const ing = new Map(ingredients.map((i) => [String(i._id), { name: i.name, unit: i.unit, lastPrice: i.stats?.lastPrice ?? null }]));
  const t = theoreticalUse(sales, recipes);
  const sum = (list) => list.reduce((m, x) => m.set(String(x.ingredientId), (m.get(String(x.ingredientId)) || 0) + x.quantity), new Map());
  // Two counts around the period: the last one before it starts (or the day it starts) and the last one inside it
  const closingCount = counts.find((c) => c.date > from && c.date <= to) || null;
  const openingCount = counts.find((c) => c.date <= from) || null;
  const asMap = (c) => (c ? new Map(c.lines.map((l) => [String(l.ingredientId), l.quantity])) : null);
  const useCounts = openingCount && closingCount;
  const rows = reconcile({ theoretical: t.use, purchased: sum(prices), wasted: sum(wastes), opening: useCounts ? asMap(openingCount) : null, closing: useCounts ? asMap(closingCount) : null, ingredients: ing });
  const lost = rows.reduce((n, r) => n + (r.value > 0 ? r.value : 0), 0);
  res.json({
    from, to, rows,
    sales: { units: t.units, covered: t.covered, days: new Set(sales.map((s) => s.date)).size, uncovered: t.uncovered.slice(0, 20) },
    counts: useCounts ? { opening: openingCount.date, closing: closingCount.date } : null,
    totals: { lost: Math.round(lost * 100) / 100, wasted: Math.round(wastes.reduce((n, w) => n + (w.cost || 0), 0) * 100) / 100 },
  });
});

// GET /api/consumption/stock → the last count (to start the next one from it) and the list of counts
exports.stock = wrap(async (req, res) => {
  const counts = await StockCount.find({ businessId: req.businessId }).sort({ date: -1 }).limit(12).lean();
  res.json({ counts: counts.map((c) => ({ id: c._id, date: c.date, items: c.lines.length, note: c.note })), last: counts[0] ? { date: counts[0].date, lines: counts[0].lines.map((l) => ({ ingredientId: l.ingredientId, quantity: l.quantity })) } : null });
});

// POST /api/consumption/stock { date, lines: [{ ingredientId, quantity }], note }
exports.saveStock = wrap(async (req, res) => {
  const { businessId } = req;
  const date = String(req.body?.date || today());
  if (!DATE_RE.test(date)) return bad(res, 'La fecha no es válida');
  const raw = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const lines = [];
  const seen = new Set();
  for (const l of raw) {
    if (l?.quantity === '' || l?.quantity === null || l?.quantity === undefined) continue;   // not counted
    const quantity = Number(l.quantity);
    if (!isId(l?.ingredientId) || !Number.isFinite(quantity) || quantity < 0) return bad(res, 'Hay una cantidad que no es válida');
    if (seen.has(String(l.ingredientId))) continue;
    seen.add(String(l.ingredientId));
    lines.push({ ingredientId: l.ingredientId, quantity });
  }
  if (!lines.length) return bad(res, 'Cuenta al menos un ingrediente');
  const found = await Ingredient.countDocuments({ businessId, _id: { $in: lines.map((l) => l.ingredientId) } });
  if (found !== lines.length) return bad(res, 'Algún ingrediente no existe');
  const doc = await StockCount.findOneAndUpdate({ businessId, date }, { $set: { lines, note: String(req.body?.note || '').slice(0, 300) } }, { upsert: true, new: true }).lean();
  res.json({ id: doc._id, date: doc.date, items: doc.lines.length });
});

// GET /api/consumption/waste?from&to · POST /api/consumption/waste · DELETE /api/consumption/waste/:id
exports.listWaste = wrap(async (req, res) => {
  const { from, to } = range(req.query);
  const [entries, ingredients] = await Promise.all([
    WasteEntry.find({ businessId: req.businessId, date: { $gte: from, $lte: to } }).sort({ date: -1, createdAt: -1 }).limit(200).lean(),
    Ingredient.find({ businessId: req.businessId }).select('name unit').lean(),
  ]);
  const ing = new Map(ingredients.map((i) => [String(i._id), i]));
  res.json({ from, to, entries: entries.map((e) => ({ id: e._id, date: e.date, ingredientId: e.ingredientId, name: ing.get(String(e.ingredientId))?.name || 'Ingrediente borrado', unit: ing.get(String(e.ingredientId))?.unit || 'kg', quantity: e.quantity, reason: e.reason, note: e.note, cost: e.cost })) });
});

exports.addWaste = wrap(async (req, res) => {
  const { businessId } = req;
  const date = String(req.body?.date || today());
  const quantity = Number(req.body?.quantity);
  const reason = ['expired', 'broken', 'mistake', 'staff', 'other'].includes(req.body?.reason) ? req.body.reason : 'other';
  if (!DATE_RE.test(date)) return bad(res, 'La fecha no es válida');
  if (!isId(req.body?.ingredientId)) return bad(res, 'Elige el ingrediente');
  if (!Number.isFinite(quantity) || quantity <= 0) return bad(res, 'La cantidad no es válida');
  const ing = await Ingredient.findOne({ _id: req.body.ingredientId, businessId }).select('stats').lean();
  if (!ing) return bad(res, 'El ingrediente no existe', 404);
  const price = ing.stats?.lastPrice ?? null;
  const doc = await WasteEntry.create({ businessId, date, ingredientId: req.body.ingredientId, quantity, reason, note: String(req.body?.note || '').slice(0, 300), cost: price === null ? null : Math.round(quantity * price * 100) / 100 });
  res.status(201).json({ id: doc._id });
});

exports.removeWaste = wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 'Registro no válido');
  await WasteEntry.deleteOne({ _id: req.params.id, businessId: req.businessId });
  res.json({ ok: true });
});
