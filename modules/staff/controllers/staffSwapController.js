/**
 * Shift swaps between employees: A gives a published shift to a colleague (or to anyone),
 * the colleague accepts, the manager approves, and only then does the shift change hands.
 */
const StaffShiftSwap = require('../models/StaffShiftSwap');
const StaffAssignment = require('../models/StaffAssignment');
const StaffEmployee = require('../models/StaffEmployee');
const StaffTimeOff = require('../models/StaffTimeOff');
const StaffSchedulePublication = require('../models/StaffSchedulePublication');
const { weekOf } = require('../lib/mySchedule');
const { whyCannotTake, OPEN } = require('../lib/swaps');
const { snapshotRow } = require('../lib/scheduleDiff');
const { resolveMyEmployee, fullName } = require('../lib/myEmployee');
const { businessToday, SHIFT_FIELDS } = require('../lib/weekData');
const { fmtDayEs } = require('../lib/dates');
const { notifyEmployees, notifyManagers } = require('../services/staffNotifications');

const asRow = (a) => snapshotRow({ ...a, shift: a.shiftId && a.shiftId._id ? a.shiftId : null, shiftId: a.shiftId?._id || a.shiftId });
const shiftText = (row) => `${fmtDayEs(row.date)} · ${row.start}–${row.end}${row.shiftName ? ` (${row.shiftName})` : ''}`;

/** Can `taker` work `row`? Looks at what they already have that day and at their approved time off. */
async function takerBlocker(businessId, taker, row, ignoreAssignmentId = null) {
  const [mine, off] = await Promise.all([
    StaffAssignment.find({ businessId, employeeId: taker._id, date: row.date }).populate('shiftId', SHIFT_FIELDS).lean(),
    StaffTimeOff.find({ businessId, employeeId: taker._id, status: 'approved', from: { $lte: row.date }, to: { $gte: row.date } }).lean(),
  ]);
  return whyCannotTake({
    shift: row, taker,
    takerShifts: mine.filter((a) => String(a._id) !== String(ignoreAssignmentId)).map(asRow),
    takerTimeOff: off,
  });
}

async function viewSwaps(swaps, businessId) {
  const ids = [...new Set(swaps.flatMap((s) => [s.fromEmployeeId, s.toEmployeeId, s.acceptedBy]).filter(Boolean).map(String))];
  const [people, assignments] = await Promise.all([
    StaffEmployee.find({ businessId, _id: { $in: ids } }).select('firstName lastName').lean(),
    StaffAssignment.find({ businessId, _id: { $in: swaps.map((s) => s.assignmentId) } }).populate('shiftId', SHIFT_FIELDS).lean(),
  ]);
  const name = new Map(people.map((p) => [String(p._id), fullName(p)]));
  const rowOf = new Map(assignments.map((a) => [String(a._id), asRow(a)]));
  return swaps.map((s) => {
    const row = rowOf.get(String(s.assignmentId));
    return {
      id: String(s._id), status: s.status, date: s.date, note: s.note, decisionNote: s.decisionNote, createdAt: s.createdAt,
      start: row?.start || '', end: row?.end || '', shiftName: row?.shiftName || '', roleLabel: row?.roleLabel || '',
      from: { id: String(s.fromEmployeeId), name: name.get(String(s.fromEmployeeId)) || '' },
      to: s.toEmployeeId ? { id: String(s.toEmployeeId), name: name.get(String(s.toEmployeeId)) || '' } : null,
      acceptedBy: s.acceptedBy ? { id: String(s.acceptedBy), name: name.get(String(s.acceptedBy)) || '' } : null,
    };
  });
}

// ---- employee ---------------------------------------------------------------

// GET /staff/me/swaps → what I asked for, and what others ask me
exports.mine = async (req, res) => {
  try {
    const me = await resolveMyEmployee(req);
    if (!me) return res.json({ linked: false, mine: [], incoming: [] });
    const today = await businessToday(req.businessId);
    const [mineRaw, openRaw] = await Promise.all([
      StaffShiftSwap.find({ businessId: req.businessId, fromEmployeeId: me._id, date: { $gte: today } }).sort({ date: 1 }).lean(),
      StaffShiftSwap.find({
        businessId: req.businessId, status: 'pending_peer', date: { $gte: today }, fromEmployeeId: { $ne: me._id },
        $or: [{ toEmployeeId: me._id }, { toEmployeeId: null }],
      }).sort({ date: 1 }).lean(),
    ]);
    const incoming = [];
    for (const v of await viewSwaps(openRaw, req.businessId)) {
      const blocked = await takerBlocker(req.businessId, me, { date: v.date, start: v.start, end: v.end }, null);
      if (blocked && !v.to) continue; // an offer to anyone: only show it if I can take it
      incoming.push({ ...v, blockedReason: blocked });
    }
    res.json({ linked: true, mine: await viewSwaps(mineRaw, req.businessId), incoming });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /staff/me/swaps/colleagues?assignmentId= → who could take this shift
exports.colleagues = async (req, res) => {
  try {
    const me = await resolveMyEmployee(req);
    if (!me) return res.json({ linked: false, items: [] });
    const a = await StaffAssignment.findOne({ _id: req.query.assignmentId, businessId: req.businessId, employeeId: me._id }).populate('shiftId', SHIFT_FIELDS).lean();
    if (!a) return res.status(404).json({ message: 'Turno no encontrado' });
    const row = asRow(a);
    const people = await StaffEmployee.find({ businessId: req.businessId, status: 'active', _id: { $ne: me._id } }).sort({ firstName: 1 }).select('firstName lastName position').lean();
    const items = [];
    for (const p of people) {
      const blocked = await takerBlocker(req.businessId, p, row);
      items.push({ id: String(p._id), name: fullName(p), position: p.position || '', blockedReason: blocked });
    }
    res.json({ linked: true, items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /staff/me/swaps { assignmentId, toEmployeeId?, note? }
exports.request = async (req, res) => {
  try {
    const me = await resolveMyEmployee(req);
    if (!me) return res.status(403).json({ message: 'Tu usuario no está enlazado a ningún empleado' });
    const { assignmentId, toEmployeeId = null, note = '' } = req.body || {};
    const a = await StaffAssignment.findOne({ _id: assignmentId, businessId: req.businessId, employeeId: me._id }).populate('shiftId', SHIFT_FIELDS).lean();
    if (!a) return res.status(404).json({ message: 'Turno no encontrado' });
    const today = await businessToday(req.businessId);
    if (a.date < today) return res.status(400).json({ message: 'Ese turno ya ha pasado' });

    const pub = await StaffSchedulePublication.findOne({ businessId: req.businessId, weekStart: weekOf(a.date)[0], 'rows.assignmentId': String(a._id) }).select('_id').lean();
    if (!pub) return res.status(400).json({ message: 'Ese turno todavía no está publicado' });
    if (await StaffShiftSwap.exists({ businessId: req.businessId, assignmentId: a._id, status: { $in: OPEN } })) {
      return res.status(409).json({ message: 'Ese turno ya tiene una solicitud abierta' });
    }

    const row = asRow(a);
    let target = null;
    if (toEmployeeId) {
      target = await StaffEmployee.findOne({ _id: toEmployeeId, businessId: req.businessId }).lean();
      if (!target || String(target._id) === String(me._id)) return res.status(400).json({ message: 'Compañero no válido' });
      const blocked = await takerBlocker(req.businessId, target, row);
      if (blocked) return res.status(409).json({ message: blocked });
    }

    const swap = await StaffShiftSwap.create({
      businessId: req.businessId, assignmentId: a._id, date: a.date, fromEmployeeId: me._id,
      toEmployeeId: target?._id || null, note: String(note).trim().slice(0, 300), status: 'pending_peer',
    });

    const text = shiftText(row);
    let recipients = [];
    if (target) recipients = [target._id];
    else {
      const all = await StaffEmployee.find({ businessId: req.businessId, status: 'active', _id: { $ne: me._id } }).lean();
      for (const p of all) if (!(await takerBlocker(req.businessId, p, row))) recipients.push(p._id);
    }
    notifyEmployees(req.businessId, recipients, {
      title: target ? `${fullName(me)} te pide que cubras su turno` : `${fullName(me)} busca quien cubra su turno`,
      body: text, url: '/mi-horario', source: 'swap_requested',
      intro: `${fullName(me)} no puede hacer este turno y pregunta si puedes cubrirlo.`,
      lines: [text, swap.note ? `Nota: ${swap.note}` : ''].filter(Boolean),
      cta: { label: 'Ver solicitud', path: '/mi-horario' },
    });
    res.status(201).json((await viewSwaps([swap.toObject()], req.businessId))[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /staff/me/swaps/:id/accept
exports.accept = async (req, res) => {
  try {
    const me = await resolveMyEmployee(req);
    if (!me) return res.status(403).json({ message: 'Tu usuario no está enlazado a ningún empleado' });
    const swap = await StaffShiftSwap.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!swap || swap.status !== 'pending_peer') return res.status(404).json({ message: 'Solicitud no disponible' });
    if (String(swap.fromEmployeeId) === String(me._id) || (swap.toEmployeeId && String(swap.toEmployeeId) !== String(me._id))) {
      return res.status(403).json({ message: 'Esta solicitud no es para ti' });
    }
    const a = await StaffAssignment.findOne({ _id: swap.assignmentId, businessId: req.businessId }).populate('shiftId', SHIFT_FIELDS).lean();
    if (!a || String(a.employeeId) !== String(swap.fromEmployeeId)) {
      swap.status = 'cancelled';
      await swap.save();
      return res.status(409).json({ message: 'Ese turno ya ha cambiado' });
    }
    const row = asRow(a);
    const blocked = await takerBlocker(req.businessId, me, row);
    if (blocked) return res.status(409).json({ message: blocked });

    swap.acceptedBy = me._id;
    swap.status = 'pending_manager';
    await swap.save();
    const text = shiftText(row);
    const from = await StaffEmployee.findById(swap.fromEmployeeId).select('firstName lastName').lean();
    notifyManagers(req.businessId, {
      title: 'Cambio de turno por aprobar', body: `${fullName(from)} → ${fullName(me)} · ${text}`, url: '/personal?tab=requests', source: 'swap_to_approve',
      intro: `${fullName(me)} ha aceptado cubrir el turno de ${fullName(from)}. Falta tu aprobación.`, lines: [text],
      cta: { label: 'Revisar cambio', path: '/personal?tab=requests' },
    });
    notifyEmployees(req.businessId, [swap.fromEmployeeId], {
      title: `${fullName(me)} cubrirá tu turno`, body: `${text}. Falta que lo apruebe tu encargado.`, url: '/mi-horario', source: 'swap_accepted',
      intro: `${fullName(me)} ha aceptado tu turno. Hasta que lo apruebe tu encargado, sigue siendo tuyo.`, lines: [text],
    });
    res.json((await viewSwaps([swap.toObject()], req.businessId))[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /staff/me/swaps/:id/decline — only when it was addressed to me
exports.decline = async (req, res) => {
  try {
    const me = await resolveMyEmployee(req);
    if (!me) return res.status(403).json({ message: 'Tu usuario no está enlazado a ningún empleado' });
    const swap = await StaffShiftSwap.findOne({ _id: req.params.id, businessId: req.businessId, toEmployeeId: me._id, status: 'pending_peer' });
    if (!swap) return res.status(404).json({ message: 'Solicitud no disponible' });
    swap.status = 'declined';
    await swap.save();
    notifyEmployees(req.businessId, [swap.fromEmployeeId], {
      title: `${fullName(me)} no puede cubrir tu turno`, body: `Puedes pedírselo a otra persona.`, url: '/mi-horario', source: 'swap_declined',
      intro: `${fullName(me)} no puede cubrir tu turno del ${fmtDayEs(swap.date)}. Puedes pedírselo a otra persona.`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /staff/me/swaps/:id — I withdraw my request
exports.cancel = async (req, res) => {
  try {
    const me = await resolveMyEmployee(req);
    if (!me) return res.status(403).json({ message: 'Tu usuario no está enlazado a ningún empleado' });
    const swap = await StaffShiftSwap.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId, fromEmployeeId: me._id, status: { $in: OPEN } },
      { status: 'cancelled' }, { new: true },
    );
    if (!swap) return res.status(404).json({ message: 'Solicitud no disponible' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ---- manager ----------------------------------------------------------------

// GET /staff/swaps?status=open|all
exports.list = async (req, res) => {
  try {
    const today = await businessToday(req.businessId);
    const q = { businessId: req.businessId, date: { $gte: today } };
    q.status = req.query.status === 'all' ? { $in: ['pending_peer', 'pending_manager', 'approved', 'rejected'] } : { $in: OPEN };
    const swaps = await StaffShiftSwap.find(q).sort({ date: 1 }).limit(200).lean();
    res.json({ items: await viewSwaps(swaps, req.businessId) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /staff/swaps/:id/decision { status: 'approved'|'rejected', note? }
exports.decide = async (req, res) => {
  try {
    const { status, note = '' } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ message: 'Estado no válido' });
    const swap = await StaffShiftSwap.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!swap || swap.status !== 'pending_manager') return res.status(404).json({ message: 'Solicitud no disponible' });

    const a = await StaffAssignment.findOne({ _id: swap.assignmentId, businessId: req.businessId }).populate('shiftId', SHIFT_FIELDS).lean();
    const row = a && asRow(a);
    const people = [swap.fromEmployeeId, swap.acceptedBy];
    const [from, to] = await Promise.all(people.map((id) => StaffEmployee.findById(id).lean()));

    if (status === 'approved') {
      if (!a || String(a.employeeId) !== String(swap.fromEmployeeId)) return res.status(409).json({ message: 'Ese turno ya ha cambiado' });
      const blocked = await takerBlocker(req.businessId, to, row, a._id);
      if (blocked) return res.status(409).json({ message: blocked });
      await StaffAssignment.updateOne({ _id: a._id }, { employeeId: swap.acceptedBy });
      // The published week follows the swap straight away: both people already agreed to it
      await StaffSchedulePublication.updateOne(
        { businessId: req.businessId, weekStart: weekOf(a.date)[0], 'rows.assignmentId': String(a._id) },
        { $set: { 'rows.$.employeeId': String(swap.acceptedBy) } },
      );
    }
    swap.status = status;
    swap.decidedBy = req.user.id;
    swap.decidedAt = new Date();
    swap.decisionNote = String(note).trim().slice(0, 300);
    await swap.save();

    const ok = status === 'approved';
    const text = row ? shiftText(row) : fmtDayEs(swap.date);
    notifyEmployees(req.businessId, people, {
      title: ok ? 'Cambio de turno aprobado' : 'Cambio de turno no aprobado', body: `${fullName(from)} → ${fullName(to)} · ${text}`, url: '/mi-horario', source: 'swap_decided',
      intro: ok ? `Tu encargado ha aprobado el cambio: ${fullName(to)} hará el turno de ${fullName(from)}.` : `Tu encargado no ha aprobado el cambio. El turno sigue siendo de ${fullName(from)}.`,
      lines: [text, swap.decisionNote ? `Nota del encargado: ${swap.decisionNote}` : ''].filter(Boolean),
      cta: { label: 'Ver mi horario', path: '/mi-horario' },
    });
    res.json((await viewSwaps([swap.toObject()], req.businessId))[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
