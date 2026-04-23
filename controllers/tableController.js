const Table    = require('../models/Table');
const Business = require('../models/Business');
const { getCapabilities, markLockedEntities } = require('../lib/planCapabilities');

async function getBusinessCaps(businessId) {
  const business = await Business.findById(businessId).select('plan subscriptionStatus').lean();
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

    const { name, capacity, roomId } = req.body;
    const table = await Table.create({ businessId: req.businessId, name, capacity, roomId: roomId || null });
    await table.populate('roomId', 'name capacity');
    res.status(201).json({ ...table.toObject(), isLocked: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateTable = async (req, res) => {
  try {
    const table = await Table.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      req.body,
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
      roomId:     t.roomId || null,
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
