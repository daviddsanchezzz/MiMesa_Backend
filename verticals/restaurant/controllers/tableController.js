const Table    = require('../models/Table');
const { pickFields } = require('../../../core/lib/pickFields');
const Business = require('../../../core/models/Business');
const { getCapabilities, markLockedEntities } = require('../../../core/lib/planCapabilities');

function normalizeShape(shape) {
  return ['circle', 'square', 'rect', 'booth'].includes(shape) ? shape : null;
}

// Any angle, rounded to steps of 15 degrees and kept in 0–345.
function normalizeAngle(angle) {
  const n = Number(angle);
  if (!Number.isFinite(n)) return 0;
  return (((Math.round(n / 15) * 15) % 360) + 360) % 360;
}

const coord = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

async function getBusinessCaps(businessId) {
  const business = await Business.findById(businessId).select('plan subscriptionStatus legacyAccess paymentFailedAt trialEndsAt stripeSubscriptionId').lean();
  return getCapabilities(business ?? {});
}

exports.getTables = async (req, res) => {
  try {
    const [docs, caps] = await Promise.all([
      // Oldest first — determines which tables are "active" within the plan limit
      Table.find({ businessId: req.businessId })
        .populate('roomId', 'name capacity')
        .sort({ createdAt: 1 }),
      getBusinessCaps(req.businessId),
    ]);

    const tables = markLockedEntities(docs, caps.maxTables);
    res.json(tables);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createTable = async (req, res) => {
  try {
    const [count, caps] = await Promise.all([
      Table.countDocuments({ businessId: req.businessId }),
      getBusinessCaps(req.businessId),
    ]);

    if (caps.maxTables !== Infinity && count >= caps.maxTables) {
      return res.status(403).json({
        message: `Tu plan Free permite hasta ${caps.maxTables} mesas. Suscríbete a Basic para añadir más.`,
        limitReached: true,
        limit: caps.maxTables,
      });
    }

    const { name, capacity, roomId, shape, angle, x, y } = req.body;
    const table = await Table.create({
      businessId: req.businessId,
      name,
      capacity,
      roomId: roomId || null,
      shape: normalizeShape(shape),
      angle: normalizeAngle(angle),
      x: coord(x),
      y: coord(y),
    });
    await table.populate('roomId', 'name capacity');
    res.status(201).json({ ...table.toObject(), isLocked: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateTable = async (req, res) => {
  try {
    const payload = pickFields(req.body, ['name', 'capacity', 'roomId', 'shape', 'angle', 'status', 'x', 'y']);
    if (Object.prototype.hasOwnProperty.call(payload, 'shape')) {
      payload.shape = normalizeShape(payload.shape);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'angle')) {
      payload.angle = normalizeAngle(payload.angle);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'x')) payload.x = coord(payload.x);
    if (Object.prototype.hasOwnProperty.call(payload, 'y')) payload.y = coord(payload.y);
    const table = await Table.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      payload,
      { new: true }
    ).populate('roomId', 'name capacity');
    if (!table) return res.status(404).json({ message: 'Table not found' });
    res.json(table);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.bulkCreateTables = async (req, res) => {
  try {
    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0)
      return res.status(400).json({ message: 'Se requiere un array de mesas' });
    if (tables.length > 200)
      return res.status(400).json({ message: 'Máximo 200 mesas por operación' });

    const [count, caps] = await Promise.all([
      Table.countDocuments({ businessId: req.businessId }),
      getBusinessCaps(req.businessId),
    ]);

    if (caps.maxTables !== Infinity) {
      const remaining = caps.maxTables - count;
      if (remaining <= 0) {
        return res.status(403).json({
          message: `Tu plan Free permite hasta ${caps.maxTables} mesas y ya has llegado al límite. Suscríbete a Basic para añadir más.`,
          limitReached: true,
          limit: caps.maxTables,
        });
      }
      if (tables.length > remaining) {
        return res.status(403).json({
          message: `Solo puedes añadir ${remaining} mesa${remaining !== 1 ? 's' : ''} más (límite del plan Free: ${caps.maxTables}).`,
          limitReached: true,
          limit: caps.maxTables,
          remaining,
        });
      }
    }

    const docs = tables.map(t => ({
      businessId: req.businessId,
      name:       String(t.name).trim(),
      capacity:   Number(t.capacity) || 2,
      shape:      normalizeShape(t.shape),
      angle:      normalizeAngle(t.angle),
      roomId:     t.roomId || null,
      x:          coord(t.x),
      y:          coord(t.y),
    }));
    const created = await Table.insertMany(docs);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteTable = async (req, res) => {
  try {
    const table = await Table.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    if (!table) return res.status(404).json({ message: 'Table not found' });
    res.json({ message: 'Table deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports._normalizeAngle = normalizeAngle;
