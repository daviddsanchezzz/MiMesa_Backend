/**
 * Days off, holidays and "I can't work then". Employees ask (they are pending until a manager
 * approves) or mark when they cannot; managers can also register them directly.
 */
const StaffTimeOff = require('../models/StaffTimeOff');
const StaffEmployee = require('../models/StaffEmployee');
const StaffAssignment = require('../models/StaffAssignment');
const { cleanTimeOff, overlapsOther, describe, isDate } = require('../lib/timeOff');
const { resolveMyEmployee, fullName } = require('../lib/myEmployee');
const { businessToday } = require('../lib/weekData');
const { notifyEmployees, notifyManagers } = require('../services/staffNotifications');

const OPEN = ['pending', 'approved'];

const view = (t, employee) => ({
  id: String(t._id), employeeId: String(t.employeeId), employeeName: employee ? fullName(employee) : undefined,
  type: t.type, from: t.from, to: t.to, fromTime: t.fromTime, toTime: t.toTime, note: t.note,
  status: t.status, requestedBy: t.requestedBy, decisionNote: t.decisionNote, decidedAt: t.decidedAt, createdAt: t.createdAt,
});

/** How many assignments of these people fall inside each period. */
async function shiftsInPeriods(businessId, items) {
  if (!items.length) return {};
  const from = items.reduce((m, t) => (t.from < m ? t.from : m), items[0].from);
  const to = items.reduce((m, t) => (t.to > m ? t.to : m), items[0].to);
  const rows = await StaffAssignment.find({ businessId, employeeId: { $in: items.map((t) => t.employeeId) }, date: { $gte: from, $lte: to } }).select('employeeId date').lean();
  const out = {};
  for (const t of items) {
    out[String(t._id)] = rows.filter((r) => String(r.employeeId) === String(t.employeeId) && r.date >= t.from && r.date <= t.to).length;
  }
  return out;
}

// ---- employee ---------------------------------------------------------------

// GET /staff/me/time-off
exports.mine = async (req, res) => {
  try {
    const employee = await resolveMyEmployee(req);
    if (!employee) return res.json({ linked: false, items: [] });
    const today = await businessToday(req.businessId);
    const items = await StaffTimeOff.find({
      businessId: req.businessId, employeeId: employee._id, status: { $in: ['pending', 'approved', 'rejected'] }, to: { $gte: today },
    }).sort({ from: 1 }).lean();
    res.json({ linked: true, items: items.map((t) => view(t)) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /staff/me/time-off { type, from, to?, fromTime?, toTime?, note? }
exports.request = async (req, res) => {
  try {
    const employee = await resolveMyEmployee(req);
    if (!employee) return res.status(403).json({ message: 'Tu usuario no está enlazado a ningún empleado' });
    const { value, error } = cleanTimeOff(req.body);
    if (error) return res.status(400).json({ message: error });
    const today = await businessToday(req.businessId);
    if (value.to < today) return res.status(400).json({ message: 'Esas fechas ya han pasado' });

    const existing = await StaffTimeOff.find({ businessId: req.businessId, employeeId: employee._id, status: { $in: OPEN }, to: { $gte: value.from }, from: { $lte: value.to } }).lean();
    if (existing.some((t) => overlapsOther(t, value))) return res.status(409).json({ message: 'Ya tienes una ausencia en esas fechas' });

    const item = await StaffTimeOff.create({ businessId: req.businessId, employeeId: employee._id, ...value, status: 'pending', requestedBy: 'employee' });
    const affected = (await shiftsInPeriods(req.businessId, [item]))[String(item._id)] || 0;
    notifyManagers(req.businessId, {
      title: `${fullName(employee)} pide ausencia`, body: describe(value), url: '/personal?tab=requests', source: 'time_off_requested',
      intro: `${fullName(employee)} ha pedido: ${describe(value)}.`,
      lines: [value.note ? `Nota: ${value.note}` : '', affected ? `Tiene ${affected} ${affected === 1 ? 'turno' : 'turnos'} asignados en esas fechas.` : ''].filter(Boolean),
      cta: { label: 'Revisar solicitud', path: '/personal?tab=requests' },
    });
    res.status(201).json({ ...view(item), shiftsAffected: affected });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /staff/me/time-off/:id
exports.cancelMine = async (req, res) => {
  try {
    const employee = await resolveMyEmployee(req);
    if (!employee) return res.status(403).json({ message: 'Tu usuario no está enlazado a ningún empleado' });
    const item = await StaffTimeOff.findOne({ _id: req.params.id, businessId: req.businessId, employeeId: employee._id });
    if (!item || !OPEN.includes(item.status)) return res.status(404).json({ message: 'Ausencia no encontrada' });
    const wasApproved = item.status === 'approved';
    item.status = 'cancelled';
    await item.save();
    if (wasApproved) {
      notifyManagers(req.businessId, {
        title: `${fullName(employee)} cancela su ausencia`, body: describe(item), url: '/personal?tab=requests', source: 'time_off_cancelled',
        intro: `${fullName(employee)} ya no se ausentará: ${describe(item)}.`,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ---- manager ----------------------------------------------------------------

// GET /staff/time-off?status=pending|approved|all&from=&to=
exports.list = async (req, res) => {
  try {
    const today = await businessToday(req.businessId);
    const q = { businessId: req.businessId };
    const status = req.query.status || 'all';
    q.status = status === 'all' ? { $in: ['pending', 'approved', 'rejected'] } : status;
    q.to = { $gte: isDate(req.query.from) ? req.query.from : today };
    if (isDate(req.query.to)) q.from = { $lte: req.query.to };
    const items = await StaffTimeOff.find(q).sort({ from: 1 }).limit(300).lean();
    const employees = await StaffEmployee.find({ businessId: req.businessId, _id: { $in: items.map((t) => t.employeeId) } }).select('firstName lastName').lean();
    const byId = new Map(employees.map((e) => [String(e._id), e]));
    const affected = await shiftsInPeriods(req.businessId, items.filter((t) => t.status !== 'rejected'));
    res.json({ items: items.map((t) => ({ ...view(t, byId.get(String(t.employeeId))), shiftsAffected: affected[String(t._id)] || 0 })) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /staff/time-off { employeeId, type, from, to?, ... }  — registered by the manager, approved
exports.create = async (req, res) => {
  try {
    const employee = await StaffEmployee.findOne({ _id: req.body?.employeeId, businessId: req.businessId }).lean();
    if (!employee) return res.status(404).json({ message: 'Empleado no encontrado' });
    const { value, error } = cleanTimeOff(req.body);
    if (error) return res.status(400).json({ message: error });
    const existing = await StaffTimeOff.find({ businessId: req.businessId, employeeId: employee._id, status: { $in: OPEN }, to: { $gte: value.from }, from: { $lte: value.to } }).lean();
    if (existing.some((t) => overlapsOther(t, value))) return res.status(409).json({ message: 'Esa persona ya tiene una ausencia en esas fechas' });
    const item = await StaffTimeOff.create({
      businessId: req.businessId, employeeId: employee._id, ...value,
      status: 'approved', requestedBy: 'manager', decidedBy: req.user.id, decidedAt: new Date(),
    });
    notifyEmployees(req.businessId, [employee._id], {
      title: 'Ausencia registrada', body: describe(value), url: '/mi-horario', source: 'time_off_registered',
      intro: `Tu encargado ha registrado una ausencia: ${describe(value)}.`,
    });
    const affected = (await shiftsInPeriods(req.businessId, [item]))[String(item._id)] || 0;
    res.status(201).json({ ...view(item, employee), shiftsAffected: affected });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /staff/time-off/:id/decision { status: 'approved'|'rejected', note? }
exports.decide = async (req, res) => {
  try {
    const { status, note = '' } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ message: 'Estado no válido' });
    const item = await StaffTimeOff.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!item) return res.status(404).json({ message: 'Solicitud no encontrada' });
    if (item.status !== 'pending') return res.status(409).json({ message: 'Esta solicitud ya está resuelta' });
    item.status = status;
    item.decidedBy = req.user.id;
    item.decidedAt = new Date();
    item.decisionNote = String(note).trim().slice(0, 300);
    await item.save();
    const ok = status === 'approved';
    notifyEmployees(req.businessId, [item.employeeId], {
      title: ok ? 'Ausencia aprobada' : 'Ausencia no aprobada', body: describe(item), url: '/mi-horario', source: 'time_off_decided',
      intro: ok ? `Tu encargado ha aprobado tu ausencia: ${describe(item)}.` : `Tu encargado no ha podido aprobar tu ausencia: ${describe(item)}.`,
      lines: item.decisionNote ? [`Nota del encargado: ${item.decisionNote}`] : [],
    });
    res.json(view(item));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /staff/time-off/:id
exports.remove = async (req, res) => {
  try {
    const item = await StaffTimeOff.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    if (!item) return res.status(404).json({ message: 'Ausencia no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
