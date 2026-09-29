const BusinessCategory = require('../models/BusinessCategory');

// ── Default seed ──────────────────────────────────────────────────────────────

const DEFAULTS = [
  { value: 'food',        label: 'Comida',        color: 'orange',  isDefault: true, order: 0 },
  { value: 'beverage',    label: 'Bebida',         color: 'blue',    isDefault: true, order: 1 },
  { value: 'cleaning',    label: 'Limpieza',       color: 'cyan',    isDefault: true, order: 2 },
  { value: 'supplies',    label: 'Suministros',    color: 'purple',  isDefault: true, order: 3 },
  { value: 'maintenance', label: 'Mantenimiento',  color: 'yellow',  isDefault: true, order: 4 },
  { value: 'marketing',   label: 'Marketing',      color: 'pink',    isDefault: true, order: 5 },
  { value: 'rent',        label: 'Alquiler',       color: 'red',     isDefault: true, order: 6 },
  { value: 'utilities',   label: 'Servicios',      color: 'indigo',  isDefault: true, order: 7 },
  { value: 'staff',       label: 'Personal',       color: 'violet',  isDefault: true, order: 8 },
  { value: 'other',       label: 'Otros',          color: 'slate',   isDefault: true, order: 9 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ── Controller functions ──────────────────────────────────────────────────────

async function getCategories(req, res) {
  try {
    let cats = await BusinessCategory
      .find({ businessId: req.businessId })
      .sort({ order: 1, label: 1 })
      .lean();

    // Auto-seed defaults on first access — deduplicate by value in case old
    // type-split docs exist from a previous schema version
    if (cats.length === 0) {
      const docs = DEFAULTS.map((d) => ({ ...d, businessId: req.businessId }));
      await BusinessCategory.insertMany(docs, { ordered: false }).catch(() => {});
      cats = await BusinessCategory
        .find({ businessId: req.businessId })
        .sort({ order: 1, label: 1 })
        .lean();
    }

    // Deduplicate by value (safety net for old split-type data)
    const seen = new Set();
    cats = cats.filter((c) => {
      if (seen.has(c.value)) return false;
      seen.add(c.value);
      return true;
    });

    res.json(cats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function createCategory(req, res) {
  try {
    const { label, color = 'slate' } = req.body;
    if (!label?.trim())
      return res.status(400).json({ message: 'El nombre es obligatorio' });

    let value = slugify(label.trim());
    const clash = await BusinessCategory.findOne({ businessId: req.businessId, value }).lean();
    if (clash) value = `${value}_${Date.now().toString(36)}`;

    const last = await BusinessCategory
      .findOne({ businessId: req.businessId })
      .sort({ order: -1 })
      .lean();
    const order = (last?.order ?? -1) + 1;

    const cat = await BusinessCategory.create({
      businessId: req.businessId,
      value,
      label: label.trim(),
      color,
      isDefault: false,
      order,
    });
    res.status(201).json(cat);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function updateCategory(req, res) {
  try {
    const cat = await BusinessCategory.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!cat) return res.status(404).json({ message: 'Categoría no encontrada' });
    if (cat.value === 'staff')
      return res.status(403).json({ message: 'La categoría Personal no puede modificarse' });

    const { label, color } = req.body;
    if (label !== undefined) cat.label = label.trim();
    if (color !== undefined) cat.color = color;
    await cat.save();
    res.json(cat);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function deleteCategory(req, res) {
  try {
    const cat = await BusinessCategory.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!cat) return res.status(404).json({ message: 'Categoría no encontrada' });
    if (cat.value === 'staff')
      return res.status(403).json({ message: 'La categoría Personal no puede eliminarse' });

    await cat.deleteOne();
    res.json({ message: 'Categoría eliminada' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = { getCategories, createCategory, updateCategory, deleteCategory };
