/**
 * Publishing a week. Employees only see what the manager has published, and a
 * republish tells just the people whose shifts changed.
 */
const StaffSchedulePublication = require('../models/StaffSchedulePublication');
const StaffEmployee = require('../models/StaffEmployee');
const { weekOf } = require('../lib/mySchedule');
const { diffSchedules, describeChanges } = require('../lib/scheduleDiff');
const { loadWeekRows } = require('../lib/weekData');
const { notifyEmployees } = require('../services/staffNotifications');
const { fmtRangeEs } = require('../lib/dates');

const isIso = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

// GET /staff/schedule/status?weekStart=
exports.status = async (req, res) => {
  try {
    if (!isIso(req.query.weekStart)) return res.status(400).json({ message: 'weekStart requerido (YYYY-MM-DD)' });
    const days = weekOf(req.query.weekStart);
    const [pub, rows] = await Promise.all([
      StaffSchedulePublication.findOne({ businessId: req.businessId, weekStart: days[0] }).lean(),
      loadWeekRows(req.businessId, days),
    ]);
    const diff = diffSchedules(pub?.rows || [], rows);
    res.json({
      weekStart: days[0],
      published: Boolean(pub),
      publishedAt: pub?.publishedAt || null,
      assignments: rows.length,
      changes: pub ? diff.total : rows.length,
      employeesAffected: Object.keys(diff.byEmployee).length,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /staff/schedule/publish { weekStart, notify }
exports.publish = async (req, res) => {
  try {
    const { weekStart, notify = true } = req.body || {};
    if (!isIso(weekStart)) return res.status(400).json({ message: 'weekStart requerido (YYYY-MM-DD)' });
    const days = weekOf(weekStart);
    const [prev, rows] = await Promise.all([
      StaffSchedulePublication.findOne({ businessId: req.businessId, weekStart: days[0] }).lean(),
      loadWeekRows(req.businessId, days),
    ]);
    const first = !prev;
    const diff = diffSchedules(prev?.rows || [], rows);
    if (!first && diff.total === 0) return res.json({ published: true, publishedAt: prev.publishedAt, changes: 0, notified: 0 });

    const pub = await StaffSchedulePublication.findOneAndUpdate(
      { businessId: req.businessId, weekStart: days[0] },
      { rows, publishedAt: new Date(), publishedBy: req.user.id },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    let notified = 0;
    if (notify) {
      const range = fmtRangeEs(days[0], days[6]);
      const ids = Object.keys(diff.byEmployee).filter((id) => {
        const e = diff.byEmployee[id];
        return e.added.length || e.removed.length || e.changed.length;
      });
      const employees = await StaffEmployee.find({ businessId: req.businessId, _id: { $in: ids }, status: 'active' }).select('_id').lean();
      for (const { _id } of employees) {
        const lines = describeChanges(diff.byEmployee[String(_id)], { first });
        if (!lines.length) continue;
        const mine = rows.filter((r) => r.employeeId === String(_id)).length;
        const title = first ? 'Tu horario ya está publicado' : 'Ha cambiado tu horario';
        const body = first ? `Semana del ${range}: ${mine} ${mine === 1 ? 'turno' : 'turnos'}.` : `Semana del ${range}: ${lines.length} ${lines.length === 1 ? 'cambio' : 'cambios'}.`;
        notified += await notifyEmployees(req.businessId, [_id], {
          title, body, url: '/mi-horario', source: 'schedule_published',
          intro: first ? `Estos son tus turnos de la semana del ${range}.` : `Esto es lo que cambia en tu horario de la semana del ${range}.`,
          lines, cta: { label: 'Ver mi horario', path: '/mi-horario' },
        });
      }
    }
    res.json({ published: true, publishedAt: pub.publishedAt, changes: first ? rows.length : diff.total, notified });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /staff/schedule/publish?weekStart=  — back to draft: employees stop seeing it
exports.unpublish = async (req, res) => {
  try {
    if (!isIso(req.query.weekStart)) return res.status(400).json({ message: 'weekStart requerido (YYYY-MM-DD)' });
    const days = weekOf(req.query.weekStart);
    await StaffSchedulePublication.deleteOne({ businessId: req.businessId, weekStart: days[0] });
    res.json({ published: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
