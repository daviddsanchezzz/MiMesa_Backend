const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const InvoiceItem = require('../models/InvoiceItem');
const Supplier = require('../models/Supplier');
const Ingredient = require('../models/Ingredient');
const IngredientPrice = require('../models/IngredientPrice');
const CostSettings = require('../models/CostSettings');
const { lineKey, suggestFromDescription } = require('../lib/ingredientParse');
const sync = require('../services/ingredientSync');

const isId = (id) => mongoose.isValidObjectId(id);
const bad = (res, message, status = 400) => res.status(status).json({ message });
const UNITS = ['kg', 'l', 'ud'];
const num = (v) => { if (v === null || v === undefined) return null; const n = Number(v.toString()); return Number.isFinite(n) ? n : null; };
const nameKey = (name) => lineKey(name);

async function alertPctOf(businessId) {
  const s = await CostSettings.findOne({ businessId }).lean();
  return s?.alertPct || 5;
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err?.code === 11000) return bad(res, 'Ya tienes un ingrediente con ese nombre', 409);
    console.error('[ingredients]', err);
    res.status(500).json({ message: 'Algo ha fallado. Inténtalo de nuevo.' });
  }
};

function serialize(ing, extra = {}) {
  return {
    id: ing._id, name: ing.name, unit: ing.unit, aliases: ing.aliases?.length || 0,
    lastPrice: ing.stats?.lastPrice ?? null, lastDate: ing.stats?.lastDate ?? null, lastSupplierId: ing.stats?.lastSupplierId ?? null,
    prevPrice: ing.stats?.prevPrice ?? null, prevDate: ing.stats?.prevDate ?? null, changePct: ing.stats?.changePct ?? null,
    minPrice: ing.stats?.minPrice ?? null, maxPrice: ing.stats?.maxPrice ?? null, count: ing.stats?.count || 0,
    ...extra,
  };
}

// GET /api/ingredients → the list, with the last prices of each (for the little chart), supplier names and what waits to be linked
exports.list = wrap(async (req, res) => {
  const businessId = req.businessId;
  const [ingredients, alertPct] = await Promise.all([Ingredient.find({ businessId }).sort({ name: 1 }).lean(), alertPctOf(businessId)]);
  const since = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const [prices, suppliers, pending] = await Promise.all([
    IngredientPrice.find({ businessId, date: { $gte: since } }).sort({ date: 1, createdAt: 1 }).select('ingredientId price date').lean(),
    Supplier.find({ businessId }).select('name').lean(),
    unlinkedGroups(businessId),
  ]);
  const spark = new Map();
  for (const p of prices) {
    const k = String(p.ingredientId);
    if (!spark.has(k)) spark.set(k, []);
    spark.get(k).push(p.price);
  }
  const names = new Map(suppliers.map((s) => [String(s._id), s.name]));
  res.json({
    alertPct,
    pending: pending.length,
    ingredients: ingredients.map((i) => serialize(i, {
      supplier: names.get(String(i.stats?.lastSupplierId)) || '',
      spark: (spark.get(String(i._id)) || []).slice(-10),
    })),
  });
});

// GET /api/ingredients/:id → detail with the history of purchases
exports.get = wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 'Ingrediente no encontrado', 404);
  const ing = await Ingredient.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
  if (!ing) return bad(res, 'Ingrediente no encontrado', 404);
  const [history, suppliers, invoices] = await Promise.all([
    IngredientPrice.find({ businessId: req.businessId, ingredientId: ing._id }).sort({ date: -1, createdAt: -1 }).limit(120).lean(),
    Supplier.find({ businessId: req.businessId }).select('name').lean(),
    null,
  ]);
  void invoices;
  const names = new Map(suppliers.map((s) => [String(s._id), s.name]));
  const invoiceIds = [...new Set(history.map((h) => String(h.invoiceId)))];
  const numbers = new Map((await Invoice.find({ _id: { $in: invoiceIds }, businessId: req.businessId }).select('invoiceNumber').lean()).map((i) => [String(i._id), i.invoiceNumber]));
  res.json({
    ...serialize(ing, { supplier: names.get(String(ing.stats?.lastSupplierId)) || '' }),
    aliasList: ing.aliases.map((a) => ({ key: a.key, label: a.label, content: a.content })),
    history: history.map((h) => ({
      id: h._id, date: h.date, price: h.price, quantity: h.quantity, description: h.description,
      supplier: names.get(String(h.supplierId)) || '', invoiceId: h.invoiceId, invoiceNumber: numbers.get(String(h.invoiceId)) || '',
    })),
  });
});

function validName(body) {
  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Pon el nombre del ingrediente' };
  if (name.length > 80) return { error: 'El nombre es demasiado largo' };
  return { name };
}

// POST /api/ingredients { name, unit }
exports.create = wrap(async (req, res) => {
  const { name, error } = validName(req.body);
  if (error) return bad(res, error);
  const unit = UNITS.includes(req.body?.unit) ? req.body.unit : 'kg';
  const doc = await Ingredient.create({ businessId: req.businessId, name, nameKey: nameKey(name), unit });
  res.status(201).json(serialize(doc.toObject()));
});

// PUT /api/ingredients/:id { name?, unit? }
exports.update = wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 'Ingrediente no encontrado', 404);
  const ing = await Ingredient.findOne({ _id: req.params.id, businessId: req.businessId });
  if (!ing) return bad(res, 'Ingrediente no encontrado', 404);
  if (req.body?.name !== undefined) {
    const { name, error } = validName(req.body);
    if (error) return bad(res, error);
    ing.name = name; ing.nameKey = nameKey(name);
  }
  if (req.body?.unit !== undefined) {
    if (!UNITS.includes(req.body.unit)) return bad(res, 'Unidad no válida');
    ing.unit = req.body.unit;
  }
  await ing.save();
  res.json(serialize(ing.toObject()));
});

// DELETE /api/ingredients/:id: the lines go back to "por vincular"
exports.remove = wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 'Ingrediente no encontrado', 404);
  const ing = await Ingredient.findOne({ _id: req.params.id, businessId: req.businessId }).select('_id').lean();
  if (!ing) return bad(res, 'Ingrediente no encontrado', 404);
  await Promise.all([
    InvoiceItem.updateMany({ businessId: req.businessId, ingredientId: ing._id }, { $set: { ingredientId: null, content: null } }),
    IngredientPrice.deleteMany({ businessId: req.businessId, ingredientId: ing._id }),
  ]);
  await Ingredient.deleteOne({ _id: ing._id, businessId: req.businessId });
  res.json({ ok: true });
});

/** Lines of the invoices not linked to an ingredient yet, grouped by how they are written. */
async function unlinkedGroups(businessId) {
  const invoices = await Invoice.find({ businessId, status: { $in: ['REVIEW', 'CONFIRMED'] } })
    .select('invoiceDate supplierId status createdAt').sort({ createdAt: -1 }).limit(400).lean();
  if (!invoices.length) return [];
  const byInvoice = new Map(invoices.map((i) => [String(i._id), i]));
  const items = await InvoiceItem.find({ businessId, invoiceId: { $in: invoices.map((i) => i._id) }, ingredientId: null }).select('invoiceId description unitPrice discount quantity').lean();
  const suppliers = new Map((await Supplier.find({ businessId }).select('name').lean()).map((s) => [String(s._id), s.name]));
  const groups = new Map();
  for (const it of items) {
    const key = lineKey(it.description);
    if (!key) continue;
    const inv = byInvoice.get(String(it.invoiceId));
    const date = inv?.invoiceDate || new Date(inv?.createdAt || Date.now()).toISOString().slice(0, 10);
    const g = groups.get(key) || { key, description: it.description, lines: 0, invoices: new Set(), lastDate: '', lastUnitPrice: null, suppliers: new Set(), confirmed: 0 };
    g.lines += 1;
    g.invoices.add(String(it.invoiceId));
    if (inv?.status === 'CONFIRMED') g.confirmed += 1;
    if (inv?.supplierId && suppliers.get(String(inv.supplierId))) g.suppliers.add(suppliers.get(String(inv.supplierId)));
    if (date >= g.lastDate) { g.lastDate = date; g.lastUnitPrice = num(it.unitPrice); g.description = it.description; }
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.lastDate.localeCompare(a.lastDate) || b.lines - a.lines)
    .map((g) => ({ key: g.key, description: g.description, lines: g.lines, invoices: g.invoices.size, lastDate: g.lastDate, lastUnitPrice: g.lastUnitPrice, suppliers: [...g.suppliers].slice(0, 3), suggestion: suggestFromDescription(g.description) }));
}

// GET /api/ingredients/inbox
exports.inbox = wrap(async (req, res) => {
  const [groups, ingredients] = await Promise.all([unlinkedGroups(req.businessId), Ingredient.find({ businessId: req.businessId }).select('name unit').sort({ name: 1 }).lean()]);
  // A suggestion that names an ingredient that already exists points to it
  const byKey = new Map(ingredients.map((i) => [nameKey(i.name), i]));
  res.json({
    groups: groups.map((g) => {
      const same = byKey.get(nameKey(g.suggestion.name));
      return { ...g, suggestion: { ...g.suggestion, ingredientId: same?._id || null } };
    }),
  });
});

// POST /api/ingredients/link { key, ingredientId | create: { name, unit }, content }
exports.link = wrap(async (req, res) => {
  const businessId = req.businessId;
  const key = String(req.body?.key || '').trim();
  if (!key) return bad(res, 'Falta la línea que vincular');
  const content = Number(String(req.body?.content ?? '').replace(',', '.'));
  if (!(content > 0) || content > 100000) return bad(res, 'Pon cuánto trae cada unidad que compras (por ejemplo 1 o 12,5)');

  let ing;
  if (req.body?.ingredientId) {
    if (!isId(req.body.ingredientId)) return bad(res, 'Ingrediente no encontrado', 404);
    ing = await Ingredient.findOne({ _id: req.body.ingredientId, businessId });
    if (!ing) return bad(res, 'Ingrediente no encontrado', 404);
  } else {
    const { name, error } = validName(req.body?.create);
    if (error) return bad(res, error);
    const unit = UNITS.includes(req.body?.create?.unit) ? req.body.create.unit : 'kg';
    ing = await Ingredient.findOne({ businessId, nameKey: nameKey(name) }) || await Ingredient.create({ businessId, name, nameKey: nameKey(name), unit });
  }

  // The unlinked lines written this way, in any invoice of the business
  const invoiceIds = (await Invoice.find({ businessId, status: { $in: ['REVIEW', 'CONFIRMED'] } }).select('_id').lean()).map((i) => i._id);
  const candidates = await InvoiceItem.find({ businessId, invoiceId: { $in: invoiceIds }, ingredientId: null }).select('description invoiceId').lean();
  const hits = candidates.filter((c) => lineKey(c.description) === key);
  const label = hits[0]?.description || String(req.body?.label || '').slice(0, 160);

  ing.aliases = [...ing.aliases.filter((a) => a.key !== key), { key, label, content }];
  await ing.save();
  if (hits.length) await InvoiceItem.updateMany({ _id: { $in: hits.map((h) => h._id) } }, { $set: { ingredientId: ing._id, content } });
  const affected = new Set();
  for (const invoiceId of new Set(hits.map((h) => String(h.invoiceId)))) {
    for (const id of await sync.rebuildPrices(businessId, invoiceId)) affected.add(id);
  }
  affected.add(String(ing._id));
  await sync.recomputeMany(businessId, [...affected]);
  const fresh = await Ingredient.findById(ing._id).lean();
  res.json({ ingredient: serialize(fresh), linked: hits.length });
});

// GET /api/ingredients/alerts → ingredients whose price went up by the chosen percentage or more in the last days
exports.alerts = wrap(async (req, res) => {
  const businessId = req.businessId;
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const pct = await alertPctOf(businessId);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const [list, suppliers] = await Promise.all([
    Ingredient.find({ businessId, 'stats.changePct': { $gte: pct }, 'stats.lastDate': { $gte: since } }).sort({ 'stats.changePct': -1 }).lean(),
    Supplier.find({ businessId }).select('name').lean(),
  ]);
  const names = new Map(suppliers.map((s) => [String(s._id), s.name]));
  res.json({ alertPct: pct, days, alerts: list.map((i) => serialize(i, { supplier: names.get(String(i.stats?.lastSupplierId)) || '' })) });
});

// GET/PUT /api/ingredients/settings
exports.getSettings = wrap(async (req, res) => {
  const s = await CostSettings.findOne({ businessId: req.businessId }).lean();
  res.json({ alertPct: s?.alertPct || 5, targetMarginPct: s?.targetMarginPct ?? 70, vatPct: s?.vatPct ?? 10 });
});
exports.saveSettings = wrap(async (req, res) => {
  const alertPct = Math.round(Number(req.body?.alertPct));
  if (!Number.isFinite(alertPct) || alertPct < 1 || alertPct > 100) return bad(res, 'El aviso va de 1 % a 100 %');
  const set = { alertPct };
  if (req.body?.targetMarginPct !== undefined) {
    const t = Math.round(Number(req.body.targetMarginPct));
    if (!Number.isFinite(t) || t < 1 || t > 95) return bad(res, 'El margen objetivo va de 1 % a 95 %');
    set.targetMarginPct = t;
  }
  if (req.body?.vatPct !== undefined) {
    const v = Number(req.body.vatPct);
    if (!Number.isFinite(v) || v < 0 || v > 30) return bad(res, 'El IVA va de 0 % a 30 %');
    set.vatPct = v;
  }
  const doc = await CostSettings.findOneAndUpdate({ businessId: req.businessId }, { $set: set }, { upsert: true, new: true }).lean();
  res.json({ alertPct: doc.alertPct, targetMarginPct: doc.targetMarginPct ?? 70, vatPct: doc.vatPct ?? 10 });
});

exports._serialize = serialize;
