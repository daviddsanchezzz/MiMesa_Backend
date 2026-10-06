const MenuSettings = require('../models/MenuSettings');
const MenuCategory = require('../models/MenuCategory');
const MenuItem = require('../models/MenuItem');
const v = require('../lib/validation');
const { DEFAULT_LANGUAGES } = require('../lib/constants');
const { normalizeRows, planImport } = require('../lib/menuImport');

const isId = (id) => /^[a-f\d]{24}$/i.test(String(id));
const notFound = (what) => new v.MenuError(`${what} no encontrado`, 404);

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof v.MenuError) return res.status(err.status).json({ message: err.message });
      console.error('[menu]', err);
      res.status(500).json({ message: 'Algo ha fallado. Inténtalo de nuevo.' });
    }
  };
}

async function settingsOf(businessId) {
  const doc = await MenuSettings.findOneAndUpdate(
    { businessId }, { $setOnInsert: { languages: DEFAULT_LANGUAGES } }, { upsert: true, new: true },
  ).lean();
  return doc;
}

async function nextOrder(Model, filter) {
  const last = await Model.findOne(filter).sort({ sortOrder: -1 }).select('sortOrder').lean();
  return (last?.sortOrder ?? -1) + 1;
}

async function ownCategory(businessId, id) {
  if (!isId(id)) throw notFound('La categoría');
  const cat = await MenuCategory.findOne({ _id: id, businessId });
  if (!cat) throw notFound('La categoría');
  return cat;
}

async function ownItem(businessId, id) {
  if (!isId(id)) throw notFound('El plato');
  const item = await MenuItem.findOne({ _id: id, businessId });
  if (!item) throw notFound('El plato');
  return item;
}

// ── Read ────────────────────────────────────────────────────────────────────
exports.getMenu = handle(async (req, res) => {
  const [settings, categories, items] = await Promise.all([
    settingsOf(req.businessId),
    MenuCategory.find({ businessId: req.businessId }).sort({ sortOrder: 1, createdAt: 1 }).lean(),
    MenuItem.find({ businessId: req.businessId }).sort({ sortOrder: 1, createdAt: 1 }).lean(),
  ]);
  res.json({ languages: settings.languages, categories, items });
});

exports.saveSettings = handle(async (req, res) => {
  const languages = v.languages(req.body?.languages);
  const doc = await MenuSettings.findOneAndUpdate({ businessId: req.businessId }, { languages }, { upsert: true, new: true }).lean();
  res.json({ languages: doc.languages });
});

// ── Categories ──────────────────────────────────────────────────────────────
exports.createCategory = handle(async (req, res) => {
  const { languages } = await settingsOf(req.businessId);
  const doc = await MenuCategory.create({
    businessId: req.businessId,
    name: v.texts(req.body?.name, languages, { label: 'El nombre', max: 80, required: true }),
    hidden: req.body?.hidden === true,
    sortOrder: await nextOrder(MenuCategory, { businessId: req.businessId }),
  });
  res.status(201).json(doc.toObject());
});

exports.updateCategory = handle(async (req, res) => {
  const cat = await ownCategory(req.businessId, req.params.id);
  const { languages } = await settingsOf(req.businessId);
  if (req.body?.name !== undefined) cat.name = v.texts(req.body.name, languages, { label: 'El nombre', max: 80, required: true });
  if (req.body?.hidden !== undefined) cat.hidden = req.body.hidden === true;
  await cat.save();
  res.json(cat.toObject());
});

exports.deleteCategory = handle(async (req, res) => {
  const cat = await ownCategory(req.businessId, req.params.id);
  if (await MenuItem.exists({ businessId: req.businessId, categoryId: cat._id })) {
    throw new v.MenuError('Esta categoría tiene platos. Muévelos o bórralos antes.', 409);
  }
  await cat.deleteOne();
  res.json({ ok: true });
});

exports.orderCategories = handle(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : v.bad('Orden no válido');
  const own = new Set((await MenuCategory.find({ businessId: req.businessId }).select('_id').lean()).map((c) => String(c._id)));
  if (ids.some((id) => !own.has(id))) v.bad('Orden no válido');
  await MenuCategory.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id, businessId: req.businessId }, update: { sortOrder: i } } })));
  res.json({ ok: true });
});

// ── Dishes ──────────────────────────────────────────────────────────────────
exports.createItem = handle(async (req, res) => {
  const cat = await ownCategory(req.businessId, req.body?.categoryId);
  const { languages } = await settingsOf(req.businessId);
  const doc = await MenuItem.create({
    businessId: req.businessId,
    categoryId: cat._id,
    name: v.texts(req.body?.name, languages, { label: 'El nombre', max: 120, required: true }),
    description: v.texts(req.body?.description, languages, { label: 'La descripción', max: 500 }),
    price: v.price(req.body?.price),
    allergens: v.allergens(req.body?.allergens) || [],
    tags: v.tags(req.body?.tags) || [],
    hidden: req.body?.hidden === true,
    sortOrder: await nextOrder(MenuItem, { businessId: req.businessId, categoryId: cat._id }),
  });
  res.status(201).json(doc.toObject());
});

exports.updateItem = handle(async (req, res) => {
  const item = await ownItem(req.businessId, req.params.id);
  const { languages } = await settingsOf(req.businessId);
  const body = req.body || {};
  if (body.name !== undefined) item.name = v.texts(body.name, languages, { label: 'El nombre', max: 120, required: true });
  if (body.description !== undefined) item.description = v.texts(body.description, languages, { label: 'La descripción', max: 500 });
  if (body.price !== undefined) {
    const next = v.price(body.price);
    if (item.priceSource === 'tpv' && next !== item.price) {
      throw new v.MenuError('El precio de este plato viene del TPV. Cámbialo allí y vuelve a importar.', 409);
    }
    item.price = next;
  }
  if (body.categoryId !== undefined && String(body.categoryId) !== String(item.categoryId)) {
    const cat = await ownCategory(req.businessId, body.categoryId);
    item.categoryId = cat._id;
    item.sortOrder = await nextOrder(MenuItem, { businessId: req.businessId, categoryId: cat._id });
  }
  if (body.allergens !== undefined) item.allergens = v.allergens(body.allergens);
  if (body.tags !== undefined) item.tags = v.tags(body.tags);
  if (body.hidden !== undefined) item.hidden = body.hidden === true;
  if (body.soldOut !== undefined) item.soldOut = body.soldOut === true;
  if (body.retired === false) item.retired = false;
  await item.save();
  res.json(item.toObject());
});

// "Agotado hoy": anyone on the team can mark it, it is not editing the menu.
exports.setSoldOut = handle(async (req, res) => {
  const item = await ownItem(req.businessId, req.params.id);
  item.soldOut = req.body?.soldOut === true;
  await item.save();
  res.json(item.toObject());
});

exports.deleteItem = handle(async (req, res) => {
  const item = await ownItem(req.businessId, req.params.id);
  await item.deleteOne();
  res.json({ ok: true });
});

exports.orderItems = handle(async (req, res) => {
  const cat = await ownCategory(req.businessId, req.body?.categoryId);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : v.bad('Orden no válido');
  const own = new Set((await MenuItem.find({ businessId: req.businessId, categoryId: cat._id }).select('_id').lean()).map((i) => String(i._id)));
  if (ids.some((id) => !own.has(id))) v.bad('Orden no válido');
  await MenuItem.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id, businessId: req.businessId }, update: { sortOrder: i } } })));
  res.json({ ok: true });
});

// ── Import from the POS ─────────────────────────────────────────────────────
// POST /api/menu/import { rows: [{ externalId, category, name, price }], apply, retireMissing }
exports.importItems = handle(async (req, res) => {
  const { rows, errors } = normalizeRows(req.body?.rows);
  if (!rows.length) return res.status(400).json({ message: errors[0]?.message || 'No hay platos que importar', errors });
  const { languages } = await settingsOf(req.businessId);
  const language = languages[0];
  const [categories, items] = await Promise.all([
    MenuCategory.find({ businessId: req.businessId }).lean(),
    MenuItem.find({ businessId: req.businessId }).lean(),
  ]);
  const { plan, missing } = planImport(rows, { categories, items, language });
  const count = (s) => plan.filter((p) => p.status === s).length;
  const summary = {
    new: count('new'), price: count('price'), link: count('link'), same: count('same'),
    missing: missing.length, newCategories: new Set(plan.filter((p) => p.categoryNew).map((p) => p.category.toLowerCase())).size,
  };
  if (req.body?.apply !== true) return res.json({ applied: false, plan, missing, errors, summary });

  // Categories first (a new one per distinct name), then the dishes
  const { strip } = require('../lib/menuImport');
  const catIds = new Map();
  for (const c of categories) for (const n of Object.values(c.name || {})) catIds.set(strip(n), c._id);
  let catOrder = await nextOrder(MenuCategory, { businessId: req.businessId });
  const itemOrder = new Map();
  for (const p of plan) {
    const key = strip(p.category);
    if (!catIds.has(key)) {
      const created = await MenuCategory.create({ businessId: req.businessId, name: { [language]: p.category }, sortOrder: catOrder++ });
      catIds.set(key, created._id);
    }
  }
  const ops = [];
  for (const p of plan) {
    const categoryId = catIds.get(strip(p.category));
    if (p.status === 'new') {
      const k = String(categoryId);
      if (!itemOrder.has(k)) itemOrder.set(k, await nextOrder(MenuItem, { businessId: req.businessId, categoryId }));
      const sortOrder = itemOrder.get(k);
      itemOrder.set(k, sortOrder + 1);
      ops.push({ insertOne: { document: { businessId: req.businessId, categoryId, name: { [language]: p.name }, price: p.price, priceSource: 'tpv', externalId: p.externalId, sortOrder } } });
    } else if (p.status !== 'same' || p.restore) {
      ops.push({ updateOne: {
        filter: { _id: p.itemId, businessId: req.businessId },
        update: { $set: { price: p.price, priceSource: 'tpv', retired: false, ...(p.externalId ? { externalId: p.externalId } : {}) } },
      } });
    }
  }
  if (req.body?.retireMissing === true) {
    for (const m of missing) ops.push({ updateOne: { filter: { _id: m.itemId, businessId: req.businessId }, update: { $set: { retired: true } } } });
  }
  if (ops.length) await MenuItem.bulkWrite(ops, { ordered: false });
  res.json({ applied: true, plan, missing, errors, summary });
});
