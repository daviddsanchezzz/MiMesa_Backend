/**
 * "Mi horario": the week of shifts of one employee, with who works at the same
 * time. Pure: the controller loads the week and passes it in. Dates are
 * 'YYYY-MM-DD'; times 'HH:MM'.
 */
const { staffTimesOf } = require('./shiftTimes');

const DAY_MS = 24 * 60 * 60 * 1000;

const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

/** Monday of the week of `date`, and the seven days of that week. */
function weekOf(date) {
  const d = asDate(date);
  const diff = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(d.getTime() - diff * DAY_MS);
  return Array.from({ length: 7 }, (_, i) => iso(new Date(monday.getTime() + i * DAY_MS)));
}

const toMinutes = (t) => {
  if (!/^\d{1,2}:\d{2}$/.test(String(t || ''))) return null;
  const [h, m] = String(t).split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
};

/** Minutes between start and end; an end before the start means the shift goes past midnight. */
function minutesBetween(start, end) {
  const a = toMinutes(start);
  const b = toMinutes(end);
  if (a === null || b === null) return 0;
  return b > a ? b - a : b + 1440 - a;
}

/** "Marta G." — enough to know who it is, nothing more. */
function shortName(employee) {
  const first = String(employee.firstName || '').trim();
  const last = String(employee.lastName || '').trim();
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

function timesOf(assignment) {
  const t = staffTimesOf(assignment.shift);
  return { start: assignment.startTime || t.start, end: assignment.endTime || t.end };
}

function overlaps(a, b) {
  const [s1, e1] = [toMinutes(a.start), toMinutes(a.end)];
  const [s2, e2] = [toMinutes(b.start), toMinutes(b.end)];
  if ([s1, e1, s2, e2].some((x) => x === null)) return false;
  return s1 < (e2 > s2 ? e2 : e2 + 1440) && s2 < (e1 > s1 ? e1 : e1 + 1440);
}

/**
 * @param {object} p
 * @param {string} p.employeeId
 * @param {string} p.date                       any date of the week
 * @param {Array}  p.assignments                of the whole week: { _id, employeeId, date, shiftId, shift?, startTime, endTime, roleLabel, notes }
 * @param {Array}  p.employees                  { _id, firstName, lastName, status }
 */
function buildMySchedule({ employeeId, date, assignments = [], employees = [] }) {
  const days = weekOf(date);
  const byId = new Map(employees.map((e) => [String(e._id), e]));
  const mine = String(employeeId);
  let totalMinutes = 0;

  const result = days.map((day) => {
    const ofDay = assignments.filter((a) => a.date === day);
    const shifts = ofDay.filter((a) => String(a.employeeId) === mine)
      .map((a) => ({ a, ...timesOf(a) }))
      .sort((x, y) => (x.start || '').localeCompare(y.start || ''))
      .map(({ a, start, end }) => {
        const coworkers = [...new Set(ofDay
          .filter((o) => String(o.employeeId) !== mine)
          .filter((o) => (a.shiftId && o.shiftId && String(a.shiftId) === String(o.shiftId)) || overlaps({ start, end }, timesOf(o)))
          .map((o) => byId.get(String(o.employeeId)))
          .filter((e) => e && e.status !== 'inactive')
          .map(shortName))];
        const minutes = minutesBetween(start, end);
        totalMinutes += minutes;
        return {
          id: String(a._id), start, end, minutes,
          shiftName: a.shift?.name || '',
          roleLabel: a.roleLabel || '',
          notes: a.notes || '',
          coworkers,
        };
      });
    return { date: day, shifts };
  });

  return { weekStart: days[0], weekEnd: days[6], days: result, totalMinutes, shiftCount: result.reduce((n, d) => n + d.shifts.length, 0) };
}

module.exports = { buildMySchedule, weekOf, minutesBetween, shortName };
