const Room  = require('../models/Room');
const Table = require('../models/Table');

exports.getRooms = async (req, res) => {
  try {
    const rooms = await Room.find({ businessId: req.businessId }).sort('name');
    // Attach table count per room
    const counts = await Table.aggregate([
      { $match: { businessId: req.businessId, roomId: { $ne: null } } },
      { $group: { _id: '$roomId', count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(counts.map(c => [c._id.toString(), c.count]));
    const result = rooms.map(r => ({ ...r.toObject(), tableCount: countMap[r._id.toString()] || 0 }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createRoom = async (req, res) => {
  try {
    const { name, capacity, description } = req.body;
    const room = await Room.create({ businessId: req.businessId, name, capacity, description });
    res.status(201).json({ ...room.toObject(), tableCount: 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateRoom = async (req, res) => {
  try {
    const room = await Room.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      req.body,
      { new: true }
    );
    if (!room) return res.status(404).json({ message: 'Room not found' });
    res.json(room);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteRoom = async (req, res) => {
  try {
    // Unassign tables from this room before deleting
    await Table.updateMany(
      { roomId: req.params.id, businessId: req.businessId },
      { $set: { roomId: null } }
    );
    const room = await Room.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    if (!room) return res.status(404).json({ message: 'Room not found' });
    res.json({ message: 'Room deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPublicRooms = async (req, res) => {
  try {
    const rooms = await Room.find({ businessId: req.params.businessId }).sort('name');
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
