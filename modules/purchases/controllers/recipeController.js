const mongoose = require('mongoose');
const MenuItem = require('../../menu/models/MenuItem');
const MenuCategory = require('../../menu/models/MenuCategory');
const Ingredient = require('../models/Ingredient');
const Recipe = require('../models/Recipe');
const CostSettings = require('../models/CostSettings');
const { costOf, marginOf, suggestedPrice } = require('../lib/recipeCost');

const isId = (id) => mongoose.isValidObjectId(id);
const bad = (res, message, status = 400) => res.status(status).json({ message });
const nameOf = (n) => (typeof n === 'string' ? n : n?.es || Object.values(n || {}).find(Boolean) || '');
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    console.error('[recipes]', err);
    res.status(500).json({ message: 'Algo ha fallado. Inténtalo de nuevo.' });
  }
};

async function settingsOf(businessId) {
  const s = await CostSettings.findOne({ businessId }).lean();
  return { targetMarginPct: s?.targetMarginPct ?? 70, vatPct: s?.vatPct ?? 10 };
}

async function ingredientMap(businessId, ids) {
  const list = await Ingredient.find({ businessId, ...(ids ? { _id: { $in: ids } } : {}) }).select('name unit stats').lean();
  return new Map(list.map((i) => [String(i._id), { name: i.name, unit: i.unit, lastPrice: i.stats?.lastPrice ?? null, prevPrice: i.stats?.prevPrice ?? null }]));
}

function summary(item, recipe, ings, settings, categories) {
  const cost = recipe ? costOf(recipe, ings) : null;
  const price = item.price ?? null;
  const m = cost ? marginOf(price, cost.cost, settings.vatPct) : { net: null, profit: null, marginPct: null };
  const cat = categories.get(String(item.categoryId));
  const parent = cat?.parentId ? categories.get(String(cat.parentId)) : null;
  return {
    id: item._id, name: nameOf(item.name), price,
    category: parent ? nameOf(parent.name) : nameOf(cat?.name), subcategory: parent ? nameOf(cat?.name) : '',
    hasRecipe: !!recipe && (recipe.lines.length > 0 || recipe.otherCost > 0),
    lines: recipe?.lines.length || 0,
    cost: cost ? cost.cost : null, before: cost ? cost.before : null, missing: cost ? cost.missing : 0,
    marginPct: m.marginPct, profit: m.profit,
    ideal: cost && cost.cost > 0 ? suggestedPrice(cost.cost, settings) : null,
    onTarget: m.marginPct === null ? null : m.marginPct >= settings.targetMarginPct,
  };
}

// GET /api/recipes → every dish of the carta with its cost and margin (dishes without a recipe come with nulls)
exports.list = wrap(async (req, res) => {
  const businessId = req.businessId;
  const [items, categories, recipes, ings, settings] = await Promise.all([
    MenuItem.find({ businessId, retired: { $ne: true } }).select('name price categoryId sortOrder').sort({ sortOrder: 1 }).lean(),
    MenuCategory.find({ businessId }).select('name parentId').lean(),
    Recipe.find({ businessId }).lean(),
    ingredientMap(businessId),
    settingsOf(businessId),
  ]);
  const catMap = new Map(categories.map((c) => [String(c._id), c]));
  const byItem = new Map(recipes.map((r) => [String(r.itemId), r]));
  const dishes = items.map((it) => summary(it, byItem.get(String(it._id)), ings, settings, catMap));
  res.json({ settings, dishes });
});

// GET /api/recipes/:itemId → one dish with its lines, ready to edit
exports.get = wrap(async (req, res) => {
  const businessId = req.businessId;
  if (!isId(req.params.itemId)) return bad(res, 'Plato no válido');
  const [item, recipe, settings] = await Promise.all([
    MenuItem.findOne({ _id: req.params.itemId, businessId }).select('name price categoryId').lean(),
    Recipe.findOne({ businessId, itemId: req.params.itemId }).lean(),
    settingsOf(businessId),
  ]);
  if (!item) return bad(res, 'Plato no encontrado', 404);
  const ings = await ingredientMap(businessId, (recipe?.lines || []).map((l) => l.ingredientId));
  const cost = costOf(recipe || { lines: [], otherCost: 0 }, ings);
  const m = marginOf(item.price ?? null, cost.cost, settings.vatPct);
  res.json({
    id: item._id, name: nameOf(item.name), price: item.price ?? null, settings,
    otherCost: recipe?.otherCost || 0,
    lines: cost.lines.map((l) => ({ ...l, name: ings.get(l.ingredientId)?.name || 'Ingrediente borrado', unit: ings.get(l.ingredientId)?.unit || 'kg', unitPrice: ings.get(l.ingredientId)?.lastPrice ?? null })),
    cost: cost.cost, before: cost.before, missing: cost.missing,
    marginPct: m.marginPct, profit: m.profit, ideal: cost.cost > 0 ? suggestedPrice(cost.cost, settings) : null,
  });
});

// PUT /api/recipes/:itemId { lines: [{ ingredientId, quantity, wastePct }], otherCost }
exports.save = wrap(async (req, res) => {
  const businessId = req.businessId;
  if (!isId(req.params.itemId)) return bad(res, 'Plato no válido');
  const item = await MenuItem.findOne({ _id: req.params.itemId, businessId }).select('_id').lean();
  if (!item) return bad(res, 'Plato no encontrado', 404);
  const raw = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (raw.length > 60) return bad(res, 'Demasiados ingredientes en un plato');
  const lines = [];
  const seen = new Set();
  for (const l of raw) {
    const quantity = Number(l?.quantity);
    const wastePct = Number(l?.wastePct) || 0;
    if (!isId(l?.ingredientId)) return bad(res, 'Ingrediente no válido');
    if (!Number.isFinite(quantity) || quantity < 0) return bad(res, 'La cantidad no es válida');
    if (wastePct < 0 || wastePct > 90) return bad(res, 'La merma va de 0 % a 90 %');
    if (seen.has(String(l.ingredientId))) return bad(res, 'Un ingrediente aparece dos veces');
    seen.add(String(l.ingredientId));
    lines.push({ ingredientId: l.ingredientId, quantity, wastePct });
  }
  const found = await Ingredient.countDocuments({ businessId, _id: { $in: lines.map((l) => l.ingredientId) } });
  if (found !== lines.length) return bad(res, 'Algún ingrediente no existe');
  const otherCost = Number(req.body?.otherCost) || 0;
  if (otherCost < 0) return bad(res, 'El coste extra no es válido');
  await Recipe.findOneAndUpdate({ businessId, itemId: item._id }, { $set: { lines, otherCost } }, { upsert: true });
  return exports.get(req, res);
});

exports.remove = wrap(async (req, res) => {
  if (!isId(req.params.itemId)) return bad(res, 'Plato no válido');
  await Recipe.deleteOne({ businessId: req.businessId, itemId: req.params.itemId });
  res.json({ ok: true });
});

// GET /api/recipes/by-ingredient/:id → the dishes that use it, with how much their cost moved because of it
exports.byIngredient = wrap(async (req, res) => {
  const businessId = req.businessId;
  if (!isId(req.params.id)) return bad(res, 'Ingrediente no válido');
  const [recipes, settings] = await Promise.all([Recipe.find({ businessId, 'lines.ingredientId': req.params.id }).lean(), settingsOf(businessId)]);
  const items = await MenuItem.find({ businessId, _id: { $in: recipes.map((r) => r.itemId) }, retired: { $ne: true } }).select('name price').lean();
  const ings = await ingredientMap(businessId, [...new Set(recipes.flatMap((r) => r.lines.map((l) => String(l.ingredientId))))]);
  const byItem = new Map(recipes.map((r) => [String(r.itemId), r]));
  res.json({ dishes: items.map((it) => {
    const c = costOf(byItem.get(String(it._id)), ings);
    const m = marginOf(it.price ?? null, c.cost, settings.vatPct);
    return { id: it._id, name: nameOf(it.name), cost: c.cost, before: c.before, marginPct: m.marginPct };
  }) });
});
