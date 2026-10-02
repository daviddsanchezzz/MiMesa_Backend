const Room  = require('../models/Room');
const Table = require('../models/Table');
const { pickFields } = require('../../../core/lib/pickFields');

// Keep only well-formed floor-plan elements (unknown kinds are dropped).
function cleanElements(list) {
  if (!Array.isArray(list)) return undefined;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
  return list.slice(0, 300)
    .filter((e) => e && Room.ELEMENT_KINDS.includes(e.kind))
    .map((e) => ({
      ...(e._id ? { _id: e._id } : {}),
      kind: e.kind,
      x: num(e.x, 0),
      y: num(e.y, 0),
      w: Math.min(4000, Math.max(4, num(e.w, 120))),
      h: Math.min(4000, Math.max(4, num(e.h, 40))),
      angle: ((num(e.angle, 0) % 360) + 360) % 360,
      label: String(e.label || '').slice(0, 60),
    }));
}

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
    const elements = cleanElements(req.body.elements) || [];
    const room = await Room.create({ businessId: req.businessId, name, capacity, description, elements });
    res.status(201).json({ ...room.toObject(), tableCount: 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateRoom = async (req, res) => {
  try {
    const payload = pickFields(req.body, ['name', 'capacity', 'description', 'elements']);
    if (Object.prototype.hasOwnProperty.call(payload, 'elements')) payload.elements = cleanElements(payload.elements) || [];
    const room = await Room.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      payload,
      { new: true, runValidators: true }
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
