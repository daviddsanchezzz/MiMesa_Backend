/**
 * Shift changes between employees. The manager always has the last word:
 *   give      A gives a shift to a colleague (or to anyone)  -> colleague accepts -> manager approves
 *   exchange  A and B swap one shift each                    -> B accepts          -> manager approves
 *   open      the manager opens a shift nobody has yet       -> someone claims it  -> manager approves
 * Nothing changes hands until the manager approves. People may be warned (other position, little
 * rest, too many hours) but only real conflicts (they work then, they are away) stop a request.
 */
const StaffShiftSwap = require('../models/StaffShiftSwap');
const StaffAssignment = require('../models/StaffAssignment');
const StaffEmployee = require('../models/StaffEmployee');
const StaffPosition = require('../models/StaffPosition');
const StaffCompensation = require('../models/StaffCompensation');
const StaffTimeOff = require('../models/StaffTimeOff');
const StaffSchedulePublication = require('../models/StaffSchedulePublication');
const Business = require('../../../core/models/Business');
const { businessTimezone, zonedDateTimeToUtc, todayInTimezone } = require('../../../core/lib/timezone');
const { weekOf } = require('../lib/mySchedule');
const { OPEN, MIN_NOTICE_HOURS, evaluateTaker, costOf } = require('../lib/swaps');
const { snapshotRow } = require('../lib/scheduleDiff');
const { resolveMyEmployee, fullName } = require('../lib/myEmployee');
const { SHIFT_FIELDS } = require('../lib/weekData');
const { fmtDayEs } = require('../lib/dates');
const { notifyEmployees, notifyManagers } = require('../services/staffNotifications');

// The restaurant vertical owns Shift; modules reach it through the connection
const Shift = { findOne: (...a) => StaffAssignment.db.model('Shift').findOne(...a), findById: (...a) => StaffAssignment.db.model('Shift').findById(...a) };

const asRow = (a) => snapshotRow({ ...a, shift: a.shiftId && a.shiftId._id ? a.shiftId : null, shiftId: a.shiftId?._id || a.shiftId });
const shiftText = (row) => `${fmtDayEs(row.date)} · ${row.start}–${row.end}${row.shiftName ? ` (${row.shiftName})` : ''}`;
const addDay = (iso, n) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const same = (a, b) => String(a) === String(b);

async function clock(businessId) {
  const business = await Business.findById(businessId).select('timezone').lean();
  const tz = businessTimezone(business);
  return { tz, today: todayInTimezone(tz) };
}

/** Is there at least `MIN_NOTICE_HOURS` before this shift starts? */
const hasNotice = (row, tz) => zonedDateTimeToUtc(row.date, row.start, tz).getTime() - Date.now() >= MIN_NOTICE_HOURS * 3600000;
const alreadyStarted = (row, tz) => zonedDateTimeToUtc(row.date, row.start, tz).getTime() <= Date.now();

/** Rows of the slot of an open shift, resolved like an assignment. */
async function slotRow(swap) {
  const shift = swap.slot?.shiftId ? await Shift.findById(swap.slot.shiftId).select(SHIFT_FIELDS).lean() : null;
  return asRow({ _id: swap._id, employeeId: null, date: swap.date, shift, shiftId: shift?._id, roleLabel: swap.slot?.roleLabel || '' });
}

/**
 * Can `taker` work `row`? { blockers, warnings }. `ignoreIds` are assignments that are moving
 * away from the taker in this same change (the shift they give in an exchange).
 */
async function checkTaker(businessId, taker, row, ignoreIds = []) {
  const days = weekOf(row.date);
  const [mine, off, positions] = await Promise.all([
    StaffAssignment.find({ businessId, employeeId: taker._id, date: { $gte: addDay(days[0], -1), $lte: addDay(days[6], 1) } }).populate('shiftId', SHIFT_FIELDS).lean(),
    StaffTimeOff.find({ businessId, employeeId: taker._id, status: 'approved', from: { $lte: row.date }, to: { $gte: row.date } }).lean(),
    StaffPosition.find({ businessId, _id: { $in: [...(taker.positionIds || []), taker.positionId].filter(Boolean) } }).select('name').lean(),
  ]);
  const rows = mine.filter((a) => !ignoreIds.some((id) => same(id, a._id))).map(asRow);
  return evaluateTaker({
    row, taker, positionNames: positions.map((p) => p.name),
    sameDay: rows.filter((r) => r.date === row.date),
    nearby: rows.filter((r) => r.date === addDay(row.date, -1) || r.date === addDay(row.date, 1)),
    week: rows.filter((r) => r.date >= days[0] && r.date <= days[6] && r.date !== row.date),
    timeOff: off,
  });
}

/** What the people in some swaps look like, with the shift each one is about. */
async function viewSwaps(swaps, businessId, { forManager = false } = {}) {
  const ids = [...new Set(swaps.flatMap((s) => [s.fromEmployeeId, s.toEmployeeId, s.acceptedBy]).filter(Boolean).map(String))];
  const assignmentIds = swaps.flatMap((s) => [s.assignmentId, s.counterAssignmentId]).filter(Boolean);
  const [people, assignments] = await Promise.all([
    StaffEmployee.find({ businessId, _id: { $in: ids } }).select('firstName lastName positionIds positionId status').lean(),
    StaffAssignment.find({ businessId, _id: { $in: assignmentIds } }).populate('shiftId', SHIFT_FIELDS).lean(),
  ]);
  const name = new Map(people.map((p) => [String(p._id), fullName(p)]));
  const rowOf = new Map(assignments.map((a) => [String(a._id), asRow(a)]));
  const person = (id) => (id ? { id: String(id), name: name.get(String(id)) || '' } : null);

  const out = [];
  for (const s of swaps) {
    const row = s.type === 'open' ? await slotRow(s) : rowOf.get(String(s.assignmentId));
    const counter = s.counterAssignmentId ? rowOf.get(String(s.counterAssignmentId)) : null;
    const view = {
      id: String(s._id), type: s.type, status: s.status, createdBy: s.createdBy, date: s.date, note: s.note, decisionNote: s.decisionNote, createdAt: s.createdAt, decidedAt: s.decidedAt,
      start: row?.start || '', end: row?.end || '', shiftName: row?.shiftName || '', roleLabel: row?.roleLabel || '',
      counter: counter ? { date: counter.date, start: counter.start, end: counter.end, shiftName: counter.shiftName, roleLabel: counter.roleLabel } : null,
      from: person(s.fromEmployeeId), to: person(s.toEmployeeId), acceptedBy: person(s.acceptedBy),
    };
    if (forManager && s.status === 'pending_manager' && row && s.acceptedBy) view.review = await reviewOf(businessId, s, row, counter, people);
    out.push(view);
  }
  return out;
}

/** For the manager at the moment of deciding: warnings of the new situation and what it costs. */
async function reviewOf(businessId, swap, row, counter, people) {
  const byId = new Map(people.map((p) => [String(p._id), p]));
  const taker = byId.get(String(swap.acceptedBy));
  const giver = swap.fromEmployeeId ? byId.get(String(swap.fromEmployeeId)) : null;
  const warnings = [];
  if (taker) {
    const w = await checkTaker(businessId, taker, row, counter ? [swap.counterAssignmentId] : []);
    warnings.push(...w.warnings.map((t) => `${taker.firstName}: ${t}`));
  }
  if (counter && giver) {
    const w = await checkTaker(businessId, giver, counter, [swap.assignmentId]);
    warnings.push(...w.warnings.map((t) => `${giver.firstName}: ${t}`));
  }
  const comps = await StaffCompensation.find({ businessId, employeeId: { $in: [swap.fromEmployeeId, swap.acceptedBy].filter(Boolean) }, isActive: true }).sort({ effectiveFrom: -1 }).lean();
  const comp = (id) => comps.find((c) => same(c.employeeId, id)) || null;
  const [a, b] = await Promise.all([
    swap.assignmentId ? StaffAssignment.findById(swap.assignmentId).select('customPrice').lean() : null,
    swap.counterAssignmentId ? StaffAssignment.findById(swap.counterAssignmentId).select('customPrice').lean() : null,
  ]);
  let before;
  let after;
  if (swap.type === 'open') { before = 0; after = costOf(row, comp(swap.acceptedBy)); }
  else if (swap.type === 'give') { before = costOf(row, comp(swap.fromEmployeeId), a?.customPrice); after = costOf(row, comp(swap.acceptedBy), a?.customPrice); }
  else {
    before = costOf(row, comp(swap.fromEmployeeId), a?.customPrice) + costOf(counter, comp(swap.acceptedBy), b?.customPrice);
    after = costOf(row, comp(swap.acceptedBy), a?.customPrice) + costOf(counter, comp(swap.fromEmployeeId), b?.customPrice);
  }
  return { warnings, cost: { before, after, delta: Number((after - before).toFixed(2)) } };
}

/** Whom to tell about an open offer: people who can take it and whose position matches. */
async function candidatesFor(businessId, row, exceptId = null) {
  const all = await StaffEmployee.find({ businessId, status: 'active', ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).lean();
  const out = [];
  for (const p of all) {
    const c = await checkTaker(businessId, p, row);
    if (!c.blockers.length && !c.warnings.some((w) => w.startsWith('Es de otro puesto'))) out.push(p._id);
  }
  return out;
}

/** The published snapshot follows an approved change straight away: all of them already agreed. */
async function patchPublished(businessId, assignment, employeeId) {
  await StaffSchedulePublication.updateOne(
    { businessId, weekStart: weekOf(assignment.date)[0], 'rows.assignmentId': String(assignment._id) },
    { $set: { 'rows.$.employeeId': String(employeeId) } },
  );
}

const noLink = (res) => res.status(403).json({ message: 'Tu usuario no está enlazado a ningún empleado' });

// ---- employee ---------------------------------------------------------------

// GET /staff/me/swaps → my requests, and what others ask me (or the open shifts I could take)
exports.mine = async (req, res) => {
  try {
    const me = await resolveMyEmployee(req);
    if (!me) return res.json({ linked: false, mine: [], incoming: [] });
    const { today, tz } = await clock(req.businessId);
    const [mineRaw, openRaw] = await Promise.all([
      StaffShiftSwap.find({ businessId: req.businessId, fromEmployeeId: me._id, date: { $gte: today } }).sort({ date: 1 }).lean(),
      StaffShiftSwap.find({
        businessId: req.businessId, status: 'pending_peer', date: { $gte: today },
        fromEmployeeId: { $ne: me._id },
        $or: [{ toEmployeeId: me._id }, { toEmployeeId: null }],
      }).sort({ date: 1 }).lean(),
    ]);
    const incoming = [];
    for (const v of await viewSwaps(openRaw, req.businessId)) {
      const row = { date: v.date, start: v.start, end: v.end, roleLabel: v.roleLabel };
      const check = await checkTaker(req.businessId, me, row, v.type === 'exchange' ? [openRaw.find((s) => String(s._id) === v.id).counterAssignmentId] : []);
      let blockedReason = check.blockers[0] || null;
      if (!blockedReason && v.type === 'exchange' && v.counter) {
        const giver = await StaffEmployee.findById(v.from.id).lean();
        blockedReason = (await checkTaker(req.businessId, giver, v.counter, [openRaw.find((s) => String(s._id) === v.id).assignmentId])).blockers[0] || null;
      }
      if (blockedReason && !v.to) continue; // offered to anyone: only show what I can take
      if (alreadyStarted(row, tz)) continue;
      incoming.push({ ...v, blockedReason, warnings: check.warnings });
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
    const people = await StaffEmployee.find({ businessId: req.businessId, status: 'active', _id: { $ne: me._id } }).sort({ firstName: 1 }).select('firstName lastName position positionIds positionId status').lean();
    const items = [];
    for (const p of people) {
      const c = await checkTaker(req.businessId, p, row);
      items.push({ id: String(p._id), name: fullName(p), position: p.position || '', blockedReason: c.blockers[0] || null, warnings: c.warnings });
    }
    res.json({ linked: true, items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /staff/me/swaps/shifts-of?employeeId=&assignmentId= → a colleague's published shifts I could take in exchange
exports.shiftsOf = async (req, res) => {
  try {
    const me = await resolveMyEmployee(req);
    if (!me) return res.json({ linked: false, items: [] });
    const { today, tz } = await clock(req.businessId);
    const mineA = await StaffAssignment.findOne({ _id: req.query.assignmentId, businessId: req.businessId, employeeId: me._id }).select('_id').lean();
    if (!mineA) return res.status(404).json({ message: 'Turno no encontrado' });
    const pubs = await StaffSchedulePublication.find({ businessId: req.businessId, weekStart: { $gte: weekOf(today)[0], $lte: addDay(today, 28) } }).lean();
    const rows = pubs.flatMap((p) => p.rows).filter((r) => r.employeeId === String(req.query.employeeId) && r.date >= today && !alreadyStarted({ date: r.date, start: r.start }, tz));
    const taken = new Set((await StaffShiftSwap.find({ businessId: req.businessId, status: { $in: OPEN }, counterAssignmentId: { $in: rows.map((r) => r.assignmentId) } }).select('counterAssignmentId').lean()).map((s) => String(s.counterAssignmentId)));
    const items = [];
    for (const r of rows.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))) {
      if (taken.has(r.assignmentId)) continue;
      const c = await checkTaker(req.businessId, me, r, [mineA._id]);
      items.push({ assignmentId: r.assignmentId, date: r.date, start: r.start, end: r.end, shiftName: r.shiftName, roleLabel: r.roleLabel, blockedReason: c.blockers[0] || null, warnings: c.warnings });
    }
    res.json({ linked: true, items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /staff/me/swaps { assignmentId, toEmployeeId?, counterAssignmentId?, note? }
exports.request = async (req, res) => {
  try {
    const me = await resolveMyEmployee(req);
    if (!me) return noLink(res);
    const { assignmentId, toEmployeeId = null, counterAssignmentId = null, note = '' } = req.body || {};
    const a = await StaffAssignment.findOne({ _id: assignmentId, businessId: req.businessId, employeeId: me._id }).populate('shiftId', SHIFT_FIELDS).lean();
    if (!a) return res.status(404).json({ message: 'Turno no encontrado' });
    const { today, tz } = await clock(req.businessId);
    const row = asRow(a);
    if (a.date < today) return res.status(400).json({ message: 'Ese turno ya ha pasado' });
    if (!hasNotice(row, tz)) return res.status(400).json({ message: `Quedan menos de ${MIN_NOTICE_HOURS} horas para ese turno: habla directamente con tu encargado` });

    const published = (id, date) => StaffSchedulePublication.exists({ businessId: req.businessId, weekStart: weekOf(date)[0], 'rows.assignmentId': String(id) });
    if (!(await published(a._id, a.date))) return res.status(400).json({ message: 'Ese turno todavía no está publicado' });
    if (await StaffShiftSwap.exists({ businessId: req.businessId, status: { $in: OPEN }, $or: [{ assignmentId: a._id }, { counterAssignmentId: a._id }] })) {
      return res.status(409).json({ message: 'Ese turno ya tiene una solicitud abierta' });
    }

    let target = null;
    let counter = null;
    let counterRow = null;
    if (toEmployeeId) {
      target = await StaffEmployee.findOne({ _id: toEmployeeId, businessId: req.businessId }).lean();
      if (!target || same(target._id, me._id)) return res.status(400).json({ message: 'Compañero no válido' });
    }
    if (counterAssignmentId) {
      if (!target) return res.status(400).json({ message: 'Para intercambiar elige con quién' });
      counter = await StaffAssignment.findOne({ _id: counterAssignmentId, businessId: req.businessId, employeeId: target._id }).populate('shiftId', SHIFT_FIELDS).lean();
      if (!counter) return res.status(404).json({ message: 'El turno de tu compañero no existe' });
      counterRow = asRow(counter);
      if (counter.date < today || !hasNotice(counterRow, tz)) return res.status(400).json({ message: 'El turno de tu compañero ya está demasiado cerca' });
      if (!(await published(counter._id, counter.date))) return res.status(400).json({ message: 'El turno de tu compañero todavía no está publicado' });
      if (await StaffShiftSwap.exists({ businessId: req.businessId, status: { $in: OPEN }, $or: [{ assignmentId: counter._id }, { counterAssignmentId: counter._id }] })) {
        return res.status(409).json({ message: 'El turno de tu compañero ya tiene una solicitud abierta' });
      }
      const back = await checkTaker(req.businessId, me, counterRow, [a._id]);
      if (back.blockers.length) return res.status(409).json({ message: back.blockers[0] });
    }
    if (target) {
      const c = await checkTaker(req.businessId, target, row, counter ? [counter._id] : []);
      if (c.blockers.length) return res.status(409).json({ message: c.blockers[0] });
    }

    const swap = await StaffShiftSwap.create({
      businessId: req.businessId, type: counter ? 'exchange' : 'give', assignmentId: a._id, counterAssignmentId: counter?._id || null,
      date: a.date, counterDate: counter?.date || '', fromEmployeeId: me._id, toEmployeeId: target?._id || null,
      note: String(note).trim().slice(0, 300), createdBy: 'employee', status: 'pending_peer',
    });

    const recipients = target ? [target._id] : await candidatesFor(req.businessId, row, me._id);
    notifyEmployees(req.businessId, recipients, {
      title: counter ? `${fullName(me)} te propone cambiar de turno` : (target ? `${fullName(me)} te pide que cubras su turno` : `${fullName(me)} busca quien cubra su turno`),
      body: counter ? `Tú: ${shiftText(row)} · ${fullName(me)}: ${shiftText(counterRow)}` : shiftText(row), url: '/mi-horario', source: 'swap_requested',
      intro: counter ? `${fullName(me)} te propone intercambiar turnos.` : `${fullName(me)} no puede hacer este turno y pregunta si puedes cubrirlo.`,
      lines: counter ? [`Harías: ${shiftText(row)}`, `${fullName(me)} haría: ${shiftText(counterRow)}`, swap.note ? `Nota: ${swap.note}` : ''].filter(Boolean) : [shiftText(row), swap.note ? `Nota: ${swap.note}` : ''].filter(Boolean),
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
    if (!me) return noLink(res);
    const swap = await StaffShiftSwap.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!swap || swap.status !== 'pending_peer') return res.status(404).json({ message: 'Solicitud no disponible' });
    if (same(swap.fromEmployeeId, me._id) || (swap.toEmployeeId && !same(swap.toEmployeeId, me._id))) return res.status(403).json({ message: 'Esta solicitud no es para ti' });

    const { tz } = await clock(req.businessId);
    const ids = [swap.assignmentId, swap.counterAssignmentId].filter(Boolean);
    const assignments = await StaffAssignment.find({ businessId: req.businessId, _id: { $in: ids } }).populate('shiftId', SHIFT_FIELDS).lean();
    const a = assignments.find((x) => same(x._id, swap.assignmentId));
    const b = assignments.find((x) => same(x._id, swap.counterAssignmentId));
    const stale = swap.type !== 'open' && (!a || !same(a.employeeId, swap.fromEmployeeId) || (swap.type === 'exchange' && (!b || !same(b.employeeId, me._id))));
    if (stale) {
      swap.status = 'cancelled';
      await swap.save();
      return res.status(409).json({ message: 'Ese turno ya ha cambiado' });
    }
    const row = swap.type === 'open' ? await slotRow(swap) : asRow(a);
    if (alreadyStarted(row, tz)) return res.status(409).json({ message: 'Ese turno ya ha empezado' });
    const check = await checkTaker(req.businessId, me, row, b ? [b._id] : []);
    if (check.blockers.length) return res.status(409).json({ message: check.blockers[0] });
    if (b) {
      const giver = await StaffEmployee.findById(swap.fromEmployeeId).lean();
      const back = await checkTaker(req.businessId, giver, asRow(b), [a._id]);
      if (back.blockers.length) return res.status(409).json({ message: back.blockers[0] });
    }

    // Atomic: when two people claim the same open shift, only the first one gets it
    const claimed = await StaffShiftSwap.findOneAndUpdate({ _id: swap._id, status: 'pending_peer' }, { status: 'pending_manager', acceptedBy: me._id }, { new: true });
    if (!claimed) return res.status(409).json({ message: 'Otra persona se te ha adelantado' });

    const text = shiftText(row);
    const from = swap.fromEmployeeId ? await StaffEmployee.findById(swap.fromEmployeeId).select('firstName lastName').lean() : null;
    notifyManagers(req.businessId, {
      title: 'Cambio de turno por aprobar', body: from ? `${fullName(from)} ↔ ${fullName(me)} · ${text}` : `${fullName(me)} cubrirá · ${text}`, url: '/personal?tab=requests', source: 'swap_to_approve',
      intro: from ? `${fullName(me)} ha aceptado el cambio de turno con ${fullName(from)}. Falta tu aprobación.` : `${fullName(me)} se ofrece para cubrir un turno libre. Falta tu aprobación.`,
      lines: [text, b ? `A cambio: ${shiftText(asRow(b))}` : ''].filter(Boolean), cta: { label: 'Revisar cambio', path: '/personal?tab=requests' },
    });
    if (from) {
      notifyEmployees(req.businessId, [from._id], {
        title: `${fullName(me)} ha aceptado`, body: `${text}. Falta que lo apruebe tu encargado.`, url: '/mi-horario', source: 'swap_accepted',
        intro: `${fullName(me)} ha aceptado el cambio. Hasta que lo apruebe tu encargado, tu turno no cambia.`, lines: [text],
      });
    }
    res.json((await viewSwaps([claimed.toObject()], req.businessId))[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /staff/me/swaps/:id/decline — only when it was addressed to me
exports.decline = async (req, res) => {
  try {
    const me = await resolveMyEmployee(req);
    if (!me) return noLink(res);
    const swap = await StaffShiftSwap.findOne({ _id: req.params.id, businessId: req.businessId, toEmployeeId: me._id, status: 'pending_peer' });
    if (!swap) return res.status(404).json({ message: 'Solicitud no disponible' });
    swap.status = 'declined';
    await swap.save();
    notifyEmployees(req.businessId, [swap.fromEmployeeId], {
      title: `${fullName(me)} no puede`, body: 'Puedes pedírselo a otra persona.', url: '/mi-horario', source: 'swap_declined',
      intro: `${fullName(me)} no puede aceptar el cambio del ${fmtDayEs(swap.date)}. Puedes pedírselo a otra persona.`,
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
    if (!me) return noLink(res);
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

// GET /staff/swaps?status=open|history
exports.list = async (req, res) => {
  try {
    const { today } = await clock(req.businessId);
    const history = req.query.status === 'history';
    const q = history
      ? { businessId: req.businessId, status: { $in: ['approved', 'rejected', 'declined', 'cancelled'] }, updatedAt: { $gte: new Date(Date.now() - 60 * 86400000) } }
      : { businessId: req.businessId, status: { $in: OPEN }, date: { $gte: today } };
    const swaps = await StaffShiftSwap.find(q).sort(history ? { updatedAt: -1 } : { date: 1 }).limit(history ? 40 : 200).lean();
    res.json({ items: await viewSwaps(swaps, req.businessId, { forManager: !history }) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /staff/swaps/by-week?weekStart= → open requests of a week, to mark them in the planner
exports.byWeek = async (req, res) => {
  try {
    const days = weekOf(req.query.weekStart || new Date().toISOString().slice(0, 10));
    const swaps = await StaffShiftSwap.find({ businessId: req.businessId, status: { $in: OPEN }, date: { $gte: days[0], $lte: days[6] } })
      .select('type status assignmentId counterAssignmentId date').lean();
    res.json({ items: swaps.map((s) => ({ id: String(s._id), type: s.type, status: s.status, date: s.date, assignmentIds: [s.assignmentId, s.counterAssignmentId].filter(Boolean).map(String) })) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /staff/swaps — the manager looks for a replacement ({ assignmentId }) or opens a shift ({ date, shiftId, roleLabel })
exports.create = async (req, res) => {
  try {
    const { assignmentId, date, shiftId, roleLabel = '', note = '' } = req.body || {};
    const { today } = await clock(req.businessId);
    let swap;
    let row;
    if (assignmentId) {
      const a = await StaffAssignment.findOne({ _id: assignmentId, businessId: req.businessId }).populate('shiftId', SHIFT_FIELDS).lean();
      if (!a) return res.status(404).json({ message: 'Turno no encontrado' });
      if (a.date < today) return res.status(400).json({ message: 'Ese turno ya ha pasado' });
      if (await StaffShiftSwap.exists({ businessId: req.businessId, status: { $in: OPEN }, $or: [{ assignmentId: a._id }, { counterAssignmentId: a._id }] })) {
        return res.status(409).json({ message: 'Ese turno ya tiene una solicitud abierta' });
      }
      row = asRow(a);
      swap = await StaffShiftSwap.create({ businessId: req.businessId, type: 'give', assignmentId: a._id, date: a.date, fromEmployeeId: a.employeeId, createdBy: 'manager', note: String(note).trim().slice(0, 300) });
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date < today) return res.status(400).json({ message: 'Elige un día válido' });
      const shift = await Shift.findOne({ _id: shiftId, businessId: req.businessId }).select(SHIFT_FIELDS).lean();
      if (!shift) return res.status(404).json({ message: 'Turno no encontrado' });
      swap = await StaffShiftSwap.create({ businessId: req.businessId, type: 'open', date, slot: { shiftId: shift._id, roleLabel: String(roleLabel).trim() }, createdBy: 'manager', note: String(note).trim().slice(0, 300) });
      row = await slotRow(swap);
    }
    const text = shiftText(row);
    const from = swap.fromEmployeeId ? await StaffEmployee.findById(swap.fromEmployeeId).select('firstName lastName').lean() : null;
    notifyEmployees(req.businessId, await candidatesFor(req.businessId, row, swap.fromEmployeeId), {
      title: from ? `Se busca quien cubra a ${from.firstName}` : 'Hay un turno libre', body: `${text}${row.roleLabel ? ` · ${row.roleLabel}` : ''}`, url: '/mi-horario', source: 'swap_open',
      intro: from ? `${fullName(from)} no puede hacer este turno y tu encargado busca quien lo cubra.` : 'Tu encargado necesita a alguien en este turno.',
      lines: [text, swap.note ? `Nota: ${swap.note}` : ''].filter(Boolean), cta: { label: 'Ver turno', path: '/mi-horario' },
    });
    res.status(201).json((await viewSwaps([swap.toObject()], req.businessId))[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /staff/swaps/:id — the manager closes a request
exports.close = async (req, res) => {
  try {
    const swap = await StaffShiftSwap.findOneAndUpdate({ _id: req.params.id, businessId: req.businessId, status: { $in: OPEN } }, { status: 'cancelled', decidedBy: req.user.id, decidedAt: new Date() }, { new: true });
    if (!swap) return res.status(404).json({ message: 'Solicitud no disponible' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /staff/swaps/:id/decision { status: 'approved'|'rejected', note? }
exports.decide = async (req, res) => {
  try {
    const { status, note = '' } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ message: 'Estado no válido' });
    const swap = await StaffShiftSwap.findOne({ _id: req.params.id, businessId: req.businessId, status: 'pending_manager' });
    if (!swap) return res.status(404).json({ message: 'Solicitud no disponible' });

    const ids = [swap.assignmentId, swap.counterAssignmentId].filter(Boolean);
    const assignments = await StaffAssignment.find({ businessId: req.businessId, _id: { $in: ids } }).populate('shiftId', SHIFT_FIELDS).lean();
    const a = assignments.find((x) => same(x._id, swap.assignmentId));
    const b = assignments.find((x) => same(x._id, swap.counterAssignmentId));
    const row = swap.type === 'open' ? await slotRow(swap) : a && asRow(a);
    const [from, to] = await Promise.all([swap.fromEmployeeId ? StaffEmployee.findById(swap.fromEmployeeId).lean() : null, StaffEmployee.findById(swap.acceptedBy).lean()]);
    const involved = [swap.fromEmployeeId, swap.acceptedBy].filter(Boolean);
    const text = row ? shiftText(row) : fmtDayEs(swap.date);
    const note300 = String(note).trim().slice(0, 300);

    if (status === 'approved') {
      if (swap.type !== 'open' && (!a || !same(a.employeeId, swap.fromEmployeeId))) return res.status(409).json({ message: 'Ese turno ya ha cambiado' });
      if (swap.type === 'exchange' && (!b || !same(b.employeeId, swap.acceptedBy))) return res.status(409).json({ message: 'El turno de tu compañero ya ha cambiado' });
      const check = await checkTaker(req.businessId, to, row, b ? [b._id] : []);
      if (check.blockers.length) return res.status(409).json({ message: check.blockers[0] });
      if (b) {
        const back = await checkTaker(req.businessId, from, asRow(b), [a._id]);
        if (back.blockers.length) return res.status(409).json({ message: back.blockers[0] });
      }

      if (swap.type === 'open') {
        const created = await StaffAssignment.create({ businessId: req.businessId, employeeId: swap.acceptedBy, date: swap.date, shiftId: swap.slot.shiftId, roleLabel: swap.slot.roleLabel || '' });
        const full = await StaffAssignment.findById(created._id).populate('shiftId', SHIFT_FIELDS).lean();
        const { assignmentId, ...fields } = asRow(full);
        await StaffSchedulePublication.updateOne({ businessId: req.businessId, weekStart: weekOf(swap.date)[0] }, { $push: { rows: { assignmentId, ...fields } } });
      } else {
        await StaffAssignment.updateOne({ _id: a._id }, { employeeId: swap.acceptedBy });
        await patchPublished(req.businessId, a, swap.acceptedBy);
        if (b) {
          await StaffAssignment.updateOne({ _id: b._id }, { employeeId: swap.fromEmployeeId });
          await patchPublished(req.businessId, b, swap.fromEmployeeId);
        }
      }
      swap.status = 'approved';
    } else if (swap.type === 'open') {
      swap.status = 'pending_peer'; // someone else may still take it
      swap.acceptedBy = null;
    } else {
      swap.status = 'rejected';
    }
    swap.decidedBy = req.user.id;
    swap.decidedAt = new Date();
    swap.decisionNote = note300;
    await swap.save();

    const ok = status === 'approved';
    notifyEmployees(req.businessId, involved, {
      title: ok ? 'Cambio de turno aprobado' : 'Cambio de turno no aprobado', body: text, url: '/mi-horario', source: 'swap_decided',
      intro: ok ? 'Tu encargado ha aprobado el cambio. Ya lo tienes en tu horario.' : 'Tu encargado no ha aprobado el cambio. Tu horario sigue igual.',
      lines: [text, b ? `Y: ${shiftText(asRow(b))}` : '', note300 ? `Nota del encargado: ${note300}` : ''].filter(Boolean), cta: { label: 'Ver mi horario', path: '/mi-horario' },
    });
    res.json((await viewSwaps([swap.toObject()], req.businessId))[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
