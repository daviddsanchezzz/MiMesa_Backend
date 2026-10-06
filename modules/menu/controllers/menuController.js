const MenuSettings = require('../models/MenuSettings');
const MenuCategory = require('../models/MenuCategory');
const MenuItem = require('../models/MenuItem');
const DailyMenu = require('../models/DailyMenu');
const photos = require('../services/photoStorage');
const translation = require('../services/translationService');
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
      if (err instanceof v.MenuError || err instanceof photos.PhotoError || err instanceof translation.TranslationError) return res.status(err.status).json({ message: err.message });
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
  const [settings, categories, items, daily] = await Promise.all([
    settingsOf(req.businessId),
    MenuCategory.find({ businessId: req.businessId }).sort({ sortOrder: 1, createdAt: 1 }).lean(),
    MenuItem.find({ businessId: req.businessId }).sort({ sortOrder: 1, createdAt: 1 }).lean(),
    DailyMenu.findOne({ businessId: req.businessId }).lean(),
  ]);
  res.json({ languages: settings.languages, categories, items, daily: daily || null });
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
  // The photo goes too; a failure there must not undo the deletion
  if (item.photo?.key) photos.remove(item.photo.key).catch((err) => console.error('[menu] photo cleanup', err.message));
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
  // Never assume the till: prices are locked only when the caller says they come from the TPV; otherwise they stay editable
  const source = req.body?.priceSource === 'tpv' ? 'tpv' : 'manual';
  const { plan, missing } = planImport(rows, { categories, items, language, source });
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
      ops.push({ insertOne: { document: {
        businessId: req.businessId, categoryId, name: { [language]: p.name }, price: p.price, priceSource: source, externalId: p.externalId, sortOrder,
        ...(p.description ? { description: { [language]: p.description } } : {}),
        ...(p.allergens?.length ? { allergens: p.allergens } : {}),
        ...(p.tags?.length ? { tags: p.tags } : {}),
      } } });
    } else if (p.status !== 'same' || p.restore) {
      ops.push({ updateOne: {
        filter: { _id: p.itemId, businessId: req.businessId },
        update: { $set: { price: p.price, retired: false, ...(source === 'tpv' ? { priceSource: 'tpv' } : {}), ...(p.externalId ? { externalId: p.externalId } : {}) } },
      } });
    }
  }
  if (req.body?.retireMissing === true) {
    for (const m of missing) ops.push({ updateOne: { filter: { _id: m.itemId, businessId: req.businessId }, update: { $set: { retired: true } } } });
  }
  if (ops.length) await MenuItem.bulkWrite(ops, { ordered: false });
  res.json({ applied: true, plan, missing, errors, summary });
});

// ── Photo of a dish: POST multipart "photo" (already shrunk by the app) ─────
exports.uploadPhoto = handle(async (req, res) => {
  const item = await ownItem(req.businessId, req.params.id);
  const file = req.file;
  if (!file) throw new v.MenuError('Elige una foto');
  const kind = photos.detectImage(file.buffer);
  if (!kind) throw new v.MenuError('La foto debe ser JPEG, PNG o WebP');
  const key = photos.makeKey(req.businessId, item._id, kind.ext);
  const url = await photos.store({ key, buffer: file.buffer, mime: kind.mime });
  const previous = item.photo?.key;
  item.photo = { url, key };
  await item.save();
  if (previous) photos.remove(previous).catch((err) => console.error('[menu] photo cleanup', err.message));
  res.json(item.toObject());
});

exports.deletePhoto = handle(async (req, res) => {
  const item = await ownItem(req.businessId, req.params.id);
  const previous = item.photo?.key;
  item.photo = undefined;
  await item.save();
  if (previous) photos.remove(previous).catch((err) => console.error('[menu] photo cleanup', err.message));
  res.json(item.toObject());
});

// ── Menú del día ────────────────────────────────────────────────────────────
exports.saveDaily = handle(async (req, res) => {
  const { languages } = await settingsOf(req.businessId);
  const data = v.daily(req.body, languages);
  const doc = await DailyMenu.findOneAndUpdate({ businessId: req.businessId }, { $set: data }, { upsert: true, new: true }).lean();
  res.json(doc);
});

// ── Translation ─────────────────────────────────────────────────────────────
// POST /api/menu/translate { from, to: ['en'], items: [{ id, kind, text }] } → { translations: { id: { en } } }
exports.translateTexts = handle(async (req, res) => {
  const { languages } = await settingsOf(req.businessId);
  const from = String(req.body?.from || languages[0]);
  const to = Array.isArray(req.body?.to) ? req.body.to.filter((l) => languages.includes(l) && l !== from) : [];
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
  if (!languages.includes(from) || !to.length || !items.length) v.bad('No hay nada que traducir');
  const translations = await translation.translate({ from, items: items.map((i) => ({ ...i, targets: to })) });
  res.json({ translations });
});

const MAX_BULK = 160;
const emptyIn = (texts, lang) => !(texts && texts[lang]);

/** What is written in the main language and missing in another one, as translation requests. */
function missingTexts({ languages, categories, items, daily }) {
  const main = languages[0];
  const others = languages.slice(1);
  const out = [];
  const want = (id, kind, texts, apply) => {
    const text = texts?.[main];
    const targets = others.filter((l) => emptyIn(texts, l));
    if (text && targets.length) out.push({ id, kind, text, targets, apply });
  };
  for (const c of categories) want(`cat:${c._id}`, 'category', c.name, (lang, t) => ({ model: 'cat', id: c._id, path: `name.${lang}`, text: t }));
  for (const i of items) {
    want(`dish:${i._id}`, 'dish', i.name, (lang, t) => ({ model: 'item', id: i._id, path: `name.${lang}`, text: t }));
    want(`desc:${i._id}`, 'description', i.description, (lang, t) => ({ model: 'item', id: i._id, path: `description.${lang}`, text: t }));
  }
  if (daily) {
    want('daily:title', 'title', daily.title, (lang, t) => ({ model: 'daily', path: `title.${lang}`, text: t }));
    want('daily:includes', 'note', daily.includes, (lang, t) => ({ model: 'daily', path: `includes.${lang}`, text: t }));
    (daily.courses || []).forEach((c, ci) => {
      want(`daily:c${ci}`, 'course', c.name, (lang, t) => ({ model: 'daily', path: `courses.${ci}.name.${lang}`, text: t }));
      (c.options || []).forEach((o, oi) => want(`daily:c${ci}o${oi}`, 'option', o.name, (lang, t) => ({ model: 'daily', path: `courses.${ci}.options.${oi}.name.${lang}`, text: t })));
    });
  }
  return out;
}

async function loadMenu(businessId) {
  const [settings, categories, items, daily] = await Promise.all([
    settingsOf(businessId),
    MenuCategory.find({ businessId }).lean(),
    MenuItem.find({ businessId, retired: { $ne: true } }).lean(),
    DailyMenu.findOne({ businessId }).lean(),
  ]);
  return { languages: settings.languages, categories, items, daily };
}

// GET /api/menu/translate-missing → how many texts lack a translation
exports.countMissing = handle(async (req, res) => {
  const menu = await loadMenu(req.businessId);
  const list = missingTexts(menu);
  res.json({ texts: list.length, languages: menu.languages.slice(1) });
});

// POST /api/menu/translate-missing → translates and saves up to MAX_BULK texts; `remaining` says if there are more
exports.translateMissing = handle(async (req, res) => {
  const menu = await loadMenu(req.businessId);
  if (menu.languages.length < 2) v.bad('Añade otro idioma a la carta primero');
  const all = missingTexts(menu);
  const batch = all.slice(0, MAX_BULK);
  if (!batch.length) return res.json({ translated: 0, remaining: 0 });
  const result = await translation.translate({ from: menu.languages[0], items: batch });

  const ops = { MenuCategory: [], MenuItem: [], DailyMenu: [] };
  let translated = 0;
  for (const req2 of batch) {
    for (const [lang, text] of Object.entries(result[req2.id] || {})) {
      const w = req2.apply(lang, text);
      // Only into a text that is still empty (somebody may have written it meanwhile)
      const filter = { businessId: req.businessId, [w.path]: { $exists: false } };
      if (w.model === 'cat') ops.MenuCategory.push({ updateOne: { filter: { ...filter, _id: w.id }, update: { $set: { [w.path]: w.text } } } });
      else if (w.model === 'item') ops.MenuItem.push({ updateOne: { filter: { ...filter, _id: w.id }, update: { $set: { [w.path]: w.text } } } });
      else ops.DailyMenu.push({ updateOne: { filter, update: { $set: { [w.path]: w.text } } } });
      translated += 1;
    }
  }
  if (ops.MenuCategory.length) await MenuCategory.bulkWrite(ops.MenuCategory, { ordered: false });
  if (ops.MenuItem.length) await MenuItem.bulkWrite(ops.MenuItem, { ordered: false });
  if (ops.DailyMenu.length) await DailyMenu.bulkWrite(ops.DailyMenu, { ordered: false });
  res.json({ translated, remaining: Math.max(0, all.length - batch.length) });
});

exports._missingTexts = missingTexts;

// ── Delete the whole menu (owner): dishes, categories, menú del día and photos. Languages stay. ──
exports.clearMenu = handle(async (req, res) => {
  // Photos first: if the purge fails nothing else is deleted and it can be retried
  await photos.removeBusiness(String(req.businessId));
  const [items, categories, daily] = await Promise.all([
    MenuItem.deleteMany({ businessId: req.businessId }),
    MenuCategory.deleteMany({ businessId: req.businessId }),
    DailyMenu.deleteMany({ businessId: req.businessId }),
  ]);
  res.json({ items: items.deletedCount || 0, categories: categories.deletedCount || 0, daily: daily.deletedCount || 0 });
});
