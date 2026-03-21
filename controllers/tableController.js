const Table = require('../models/Table');

exports.getTables = async (req, res) => {
  try {
    const tables = await Table.find({ businessId: req.businessId })
      .populate('roomId', 'name capacity')
      .sort('name');
    res.json(tables);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createTable = async (req, res) => {
  try {
    const { name, capacity, roomId } = req.body;
    const table = await Table.create({ businessId: req.businessId, name, capacity, roomId: roomId || null });
    await table.populate('roomId', 'name capacity');
    res.status(201).json(table);
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
