/**
 * Publishing a week: employees see a snapshot of the schedule, not the draft the
 * manager is still editing. These are the pure helpers to take the snapshot and to
 * tell what changed between two of them (so only the people affected are warned).
 */
const { staffTimesOf } = require('./shiftTimes');

/** One assignment as employees see it: the staff hours already resolved. */
function snapshotRow(assignment) {
  const shift = assignment.shift || (assignment.shiftId && assignment.shiftId._id ? assignment.shiftId : null);
  const t = staffTimesOf(shift);
  return {
    assignmentId: String(assignment._id),
    employeeId: String(assignment.employeeId?._id || assignment.employeeId),
    date: assignment.date,
    shiftId: shift?._id ? String(shift._id) : (assignment.shiftId ? String(assignment.shiftId) : null),
    shiftName: shift?.name || '',
    start: assignment.startTime || t.start || '',
    end: assignment.endTime || t.end || '',
    roleLabel: assignment.roleLabel || '',
    notes: assignment.notes || '',
  };
}

const sameShift = (a, b) => a.start === b.start && a.end === b.end && a.date === b.date
  && a.roleLabel === b.roleLabel && a.notes === b.notes && a.shiftName === b.shiftName;

/**
 * @returns {{ byEmployee: Record<string, {added: object[], removed: object[], changed: {before: object, after: object}[]}>, total: number }}
 */
function diffSchedules(previous = [], next = []) {
  const prev = new Map(previous.map((r) => [r.assignmentId, r]));
  const cur = new Map(next.map((r) => [r.assignmentId, r]));
  const byEmployee = {};
  const bucket = (id) => (byEmployee[id] = byEmployee[id] || { added: [], removed: [], changed: [] });
  let total = 0;

  for (const [id, row] of cur) {
    const before = prev.get(id);
    if (!before) { bucket(row.employeeId).added.push(row); total++; continue; }
    if (before.employeeId !== row.employeeId) {
      bucket(before.employeeId).removed.push(before);
      bucket(row.employeeId).added.push(row);
      total++;
    } else if (!sameShift(before, row)) {
      bucket(row.employeeId).changed.push({ before, after: row });
      total++;
    }
  }
  for (const [id, row] of prev) {
    if (!cur.has(id)) { bucket(row.employeeId).removed.push(row); total++; }
  }
  return { byEmployee, total };
}

module.exports = { snapshotRow, diffSchedules };

const DAY = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const dayText = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY[d.getUTCDay()]} ${d.getUTCDate()}`;
};
const rowText = (r) => `${dayText(r.date)} · ${r.start}–${r.end}${r.shiftName ? ` (${r.shiftName})` : ''}`;

/**
 * What to tell one employee. `entry` is diffSchedules().byEmployee[id]; with `first` (the week
 * was never published) it just lists their shifts.
 * @returns {string[]}
 */
function describeChanges(entry, { first = false } = {}) {
  if (first) return (entry.added || []).sort((a, b) => a.date.localeCompare(b.date)).map(rowText);
  return [
    ...(entry.added || []).map((r) => `Nuevo: ${rowText(r)}`),
    ...(entry.changed || []).map((c) => `Cambia: ${rowText(c.before)} → ${rowText(c.after)}`),
    ...(entry.removed || []).map((r) => `Se quita: ${rowText(r)}`),
  ];
}

module.exports.describeChanges = describeChanges;
module.exports.rowText = rowText;
