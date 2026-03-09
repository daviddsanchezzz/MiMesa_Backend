const Shift = require('../models/Shift');

// Generate 30-min time slots within a window
function generateSlots(startTime, endTime) {
  const [sh, sm] = startTime.split(':').map(Number);
  let [eh, em]   = endTime.split(':').map(Number);
  if (eh === 0 && em === 0) { eh = 24; em = 0; } // midnight as end
  const slots = [];
  for (let t = sh * 60 + sm; t < eh * 60 + em; t += 30) {
    const h = Math.floor(t / 60) % 24;
    const m = t % 60;
    slots.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
  }
  return slots;
}

// Check for naming conflicts (same name, same type / overlapping date range)
async function checkConflict(businessId, name, startDate, endDate, excludeId = null) {
  const isSpecific = !!(startDate && endDate);
  const query = { businessId, name: name.trim() };
  if (excludeId) query._id = { $ne: excludeId };

  const siblings = await Shift.find(query);
  for (const s of siblings) {
    const sIsSpecific = !!(s.startDate && s.endDate);
    if (!isSpecific && !sIsSpecific) {
      return 'Ya existe un turno general con ese nombre';
    }
    if (isSpecific && sIsSpecific) {
      // Overlap: two ranges overlap if one starts before the other ends
      if (startDate <= s.endDate && endDate >= s.startDate) {
        return 'Ya existe un turno específico con ese nombre en ese rango de fechas';
      }
    }
  }
  return null;
}

exports.getShifts = async (req, res) => {
  try {
    const shifts = await Shift.find({ businessId: req.businessId }).sort({ startTime: 1 });
    res.json(shifts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/shifts/slots?date=YYYY-MM-DD
exports.getSlots = async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ message: 'date es requerido' });

    const dayOfWeek = new Date(`${date}T12:00:00Z`).getDay();

    const allShifts = await Shift.find({
      businessId: req.businessId,
      days: dayOfWeek,
    }).sort({ startTime: 1 });

    // Separate general (no dates) vs specific (covers this date)
    const general  = allShifts.filter(s => !s.startDate && !s.endDate);
    const specific = allShifts.filter(s =>
      s.startDate && s.endDate && date >= s.startDate && date <= s.endDate
    );

    // Specific overrides general by name
    const byName = {};
    general.forEach(s  => { byName[s.name] = s; });
    specific.forEach(s => { byName[s.name] = s; }); // wins

    const applicable = Object.values(byName);
    if (!applicable.length) return res.json([]);

    const slots = [];
    applicable.forEach(shift => {
      const times = shift.subShifts.length
        ? shift.subShifts.map(ss => ({ time: ss.time, label: ss.label || ss.time }))
        : generateSlots(shift.startTime, shift.endTime).map(t => ({ time: t, label: t }));

      times.forEach(({ time, label }) =>
        slots.push({ shiftId: shift._id, shiftName: shift.name, time, label })
      );
    });

    slots.sort((a, b) => a.time.localeCompare(b.time));
    res.json(slots);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createShift = async (req, res) => {
  try {
    const { name, startTime, endTime, days, subShifts, startDate, endDate } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'El nombre es obligatorio' });
    if (!startTime)    return res.status(400).json({ message: 'La hora de inicio es obligatoria' });
    if (!endTime)      return res.status(400).json({ message: 'La hora de fin es obligatoria' });
    if (!days?.length) return res.status(400).json({ message: 'Selecciona al menos un día' });
    if ((startDate && !endDate) || (!startDate && endDate))
      return res.status(400).json({ message: 'Debes indicar tanto la fecha de inicio como la de fin' });
    if (startDate && endDate && startDate > endDate)
      return res.status(400).json({ message: 'La fecha de inicio debe ser anterior a la de fin' });

    const conflict = await checkConflict(req.businessId, name, startDate || null, endDate || null);
    if (conflict) return res.status(400).json({ message: conflict });

    const shift = await Shift.create({
      businessId: req.businessId,
      name: name.trim(), startTime, endTime, days,
      startDate: startDate || null, endDate: endDate || null,
      subShifts: subShifts || [],
    });
    res.status(201).json(shift);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.updateShift = async (req, res) => {
  try {
    const { name, startTime, endTime, days, subShifts, startDate, endDate } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'El nombre es obligatorio' });
    if (!startTime)    return res.status(400).json({ message: 'La hora de inicio es obligatoria' });
    if (!endTime)      return res.status(400).json({ message: 'La hora de fin es obligatoria' });
    if (!days?.length) return res.status(400).json({ message: 'Selecciona al menos un día' });
    if ((startDate && !endDate) || (!startDate && endDate))
      return res.status(400).json({ message: 'Debes indicar tanto la fecha de inicio como la de fin' });
    if (startDate && endDate && startDate > endDate)
      return res.status(400).json({ message: 'La fecha de inicio debe ser anterior a la de fin' });

    const conflict = await checkConflict(req.businessId, name, startDate || null, endDate || null, req.params.id);
    if (conflict) return res.status(400).json({ message: conflict });

    const shift = await Shift.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      { name: name.trim(), startTime, endTime, days,
        startDate: startDate || null, endDate: endDate || null,
        subShifts: subShifts || [] },
      { new: true, runValidators: true }
    );
    if (!shift) return res.status(404).json({ message: 'Turno no encontrado' });
    res.json(shift);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.deleteShift = async (req, res) => {
  try {
    await Shift.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    res.json({ message: 'Turno eliminado' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/shifts/public/slots?date=YYYY-MM-DD&businessId=...
exports.getPublicSlots = async (req, res) => {
  try {
    const { date, businessId } = req.query;
    if (!date) return res.status(400).json({ message: 'date es requerido' });
    if (!businessId) return res.status(400).json({ message: 'businessId es requerido' });

    const dayOfWeek = new Date(`${date}T12:00:00Z`).getDay();

    const allShifts = await Shift.find({
      businessId,
      days: dayOfWeek,
    }).sort({ startTime: 1 });

    // Separate general (no dates) vs specific (covers this date)
    const general  = allShifts.filter(s => !s.startDate && !s.endDate);
    const specific = allShifts.filter(s =>
      s.startDate && s.endDate && date >= s.startDate && date <= s.endDate
    );

    // Specific overrides general by name
    const byName = {};
    general.forEach(s  => { byName[s.name] = s; });
    specific.forEach(s => { byName[s.name] = s; }); // wins

    const applicable = Object.values(byName);
    if (!applicable.length) return res.json([]);

    const slots = [];
    applicable.forEach(shift => {
      const times = shift.subShifts.length
        ? shift.subShifts.map(ss => ({ time: ss.time, label: ss.label || ss.time }))
        : generateSlots(shift.startTime, shift.endTime).map(t => ({ time: t, label: t }));

      times.forEach(({ time, label }) =>
        slots.push({ shiftId: shift._id, shiftName: shift.name, time, label })
      );
    });

    slots.sort((a, b) => a.time.localeCompare(b.time));
    res.json(slots);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
