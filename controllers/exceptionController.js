const Exception = require('../models/Exception');
const Room = require('../models/Room');
const Business = require('../models/Business');

const BLOCKING_TYPES = ['closed', 'full', 'call'];
const BLOCKING_PRIORITY = ['closed', 'full', 'call'];

function normalizeType(type) {
  return String(type || '').trim();
}

function defaultMessageForType(type, businessPhone = '') {
  if (type === 'closed') return 'Restaurante cerrado en este turno';
  if (type === 'full') return 'Turno completo';
  if (type === 'call') return businessPhone ? `Por favor, llama al ${businessPhone}` : 'Por favor, llama por telefono';
  return '';
}

function pickBlockingException(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  for (const type of BLOCKING_PRIORITY) {
    const found = entries.find((e) => e.type === type);
    if (found) return found;
  }
  return null;
}

exports.getExceptions = async (req, res) => {
  try {
    const query = { businessId: req.businessId };
    if (req.query.date) query.date = req.query.date;

    const rows = await Exception.find(query)
      .populate({ path: 'roomId', select: 'name' })
      .sort({ date: 1, shiftName: 1, createdAt: -1 });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createException = async (req, res) => {
  try {
    const { date, shiftName, type, roomId, message } = req.body || {};
    const safeType = normalizeType(type);
    const safeShift = String(shiftName || '').trim();

    if (!date) return res.status(400).json({ message: 'La fecha es obligatoria' });
    if (!safeShift) return res.status(400).json({ message: 'El turno es obligatorio' });
    if (!['closed', 'full', 'call', 'close_room'].includes(safeType)) {
      return res.status(400).json({ message: 'Tipo de excepcion invalido' });
    }

    let safeRoomId = null;
    if (safeType === 'close_room') {
      if (!roomId) return res.status(400).json({ message: 'Debes seleccionar una sala para este tipo de excepcion' });
      const room = await Room.findOne({ _id: roomId, businessId: req.businessId }).select('_id');
      if (!room) return res.status(400).json({ message: 'Sala invalida' });
      safeRoomId = room._id;
    }

    const duplicate = await Exception.findOne({
      businessId: req.businessId,
      date,
      shiftName: safeShift,
      type: safeType,
      roomId: safeRoomId,
    });
    if (duplicate) return res.status(409).json({ message: 'Ya existe esta excepcion para ese turno y fecha' });

    const row = await Exception.create({
      businessId: req.businessId,
      date,
      shiftName: safeShift,
      type: safeType,
      roomId: safeRoomId,
      message: String(message || '').trim(),
    });
    const populated = await row.populate({ path: 'roomId', select: 'name' });
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.updateException = async (req, res) => {
  try {
    const current = await Exception.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!current) return res.status(404).json({ message: 'Excepcion no encontrada' });

    const next = { ...req.body };
    if (next.type !== undefined) {
      next.type = normalizeType(next.type);
      if (!['closed', 'full', 'call', 'close_room'].includes(next.type)) {
        return res.status(400).json({ message: 'Tipo de excepcion invalido' });
      }
    }
    if (next.shiftName !== undefined) next.shiftName = String(next.shiftName || '').trim();
    if (next.message !== undefined) next.message = String(next.message || '').trim();

    const effectiveType = next.type || current.type;
    if (effectiveType === 'close_room') {
      const effectiveRoomId = next.roomId !== undefined ? next.roomId : current.roomId;
      if (!effectiveRoomId) return res.status(400).json({ message: 'Debes seleccionar una sala para este tipo de excepcion' });
      const room = await Room.findOne({ _id: effectiveRoomId, businessId: req.businessId }).select('_id');
      if (!room) return res.status(400).json({ message: 'Sala invalida' });
      next.roomId = room._id;
    } else {
      next.roomId = null;
    }

    const row = await Exception.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      next,
      { new: true, runValidators: true }
    ).populate({ path: 'roomId', select: 'name' });

    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.deleteException = async (req, res) => {
  try {
    await Exception.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    res.json({ message: 'Excepcion eliminada' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.checkPublicExceptions = async (req, res) => {
  try {
    const { date, businessId } = req.query;
    if (!date) return res.status(400).json({ message: 'date es requerido' });
    if (!businessId) return res.status(400).json({ message: 'businessId es requerido' });

    const [rows, business] = await Promise.all([
      Exception.find({ businessId, date }).populate({ path: 'roomId', select: 'name' }),
      Business.findById(businessId).select('phone').lean(),
    ]);

    const byShift = new Map();
    rows.forEach((row) => {
      const key = row.shiftName;
      if (!byShift.has(key)) byShift.set(key, []);
      byShift.get(key).push(row);
    });

    const blockedShifts = [];
    const roomClosures = [];

    for (const [shiftName, entries] of byShift.entries()) {
      const blocking = pickBlockingException(entries.filter((e) => BLOCKING_TYPES.includes(e.type)));
      if (blocking) {
        blockedShifts.push({
          shiftName,
          type: blocking.type,
          message: blocking.message || defaultMessageForType(blocking.type, business?.phone || ''),
        });
      }

      entries
        .filter((e) => e.type === 'close_room' && e.roomId)
        .forEach((e) => {
          roomClosures.push({
            shiftName,
            roomId: e.roomId?._id || e.roomId,
            roomName: e.roomId?.name || null,
            message: e.message || 'Sala cerrada para este turno',
          });
        });
    }

    res.json({
      date,
      blockedShifts,
      roomClosures,
      hasAnyBlocking: blockedShifts.length > 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

