const PromoCode = require('../models/PromoCode');

function isPromoValid(promo) {
  if (!promo.active) return false;
  if (promo.expiresAt && new Date() > new Date(promo.expiresAt)) return false;
  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) return false;
  return true;
}

// ── GET /api/promos ───────────────────────────────────────────────────────────
exports.list = async (req, res) => {
  try {
    const promos = await PromoCode.find({ businessId: req.businessId }).sort({ createdAt: -1 });
    res.json(promos);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /api/promos ──────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const { code, description, expiresAt, maxUses } = req.body;
    if (!code?.trim()) return res.status(400).json({ message: 'El código es obligatorio' });

    const promo = await PromoCode.create({
      businessId:  req.businessId,
      code:        code.trim().toUpperCase(),
      description: description?.trim() || '',
      expiresAt:   expiresAt || null,
      maxUses:     maxUses   || null,
    });
    res.status(201).json(promo);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Ya existe un código con ese nombre' });
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /api/promos/:id ───────────────────────────────────────────────────────
exports.update = async (req, res) => {
  try {
    const { code, description, active, expiresAt, maxUses } = req.body;
    const update = {};
    if (code        !== undefined) update.code        = code.trim().toUpperCase();
    if (description !== undefined) update.description = description.trim();
    if (active      !== undefined) update.active      = active;
    if (expiresAt   !== undefined) update.expiresAt   = expiresAt || null;
    if (maxUses     !== undefined) update.maxUses     = maxUses   || null;

    const promo = await PromoCode.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      { $set: update }, { new: true }
    );
    if (!promo) return res.status(404).json({ message: 'Código no encontrado' });
    res.json(promo);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Ya existe un código con ese nombre' });
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /api/promos/:id ────────────────────────────────────────────────────
exports.remove = async (req, res) => {
  try {
    const promo = await PromoCode.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    if (!promo) return res.status(404).json({ message: 'Código no encontrado' });
    res.json({ message: 'Eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /api/promos/public/:businessId/has-active ─────────────────────────────
exports.hasActive = async (req, res) => {
  try {
    const now = new Date();
    const promo = await PromoCode.findOne({
      businessId: req.params.businessId,
      active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      $or: [{ maxUses: null }, { $expr: { $lt: ['$usedCount', '$maxUses'] } }],
    }).select('_id');
    res.json({ hasActive: !!promo });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /api/promos/public/validate ─────────────────────────────────────────
exports.validate = async (req, res) => {
  try {
    const { businessId, code } = req.body;
    if (!businessId || !code) return res.status(400).json({ message: 'Faltan datos' });

    const promo = await PromoCode.findOne({
      businessId,
      code: code.trim().toUpperCase(),
    });

    if (!promo || !isPromoValid(promo)) {
      return res.status(404).json({ message: 'Código no válido o expirado' });
    }

    res.json({ valid: true, description: promo.description, promoCodeId: promo._id });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
