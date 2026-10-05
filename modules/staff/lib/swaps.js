/**
 * Shift swaps: an employee gives a shift away, two employees exchange theirs, or the manager
 * opens a shift anyone can claim. A colleague accepts, then the manager approves, and only
 * then do the shifts change hands. Pure rules; the controller loads and saves.
 *
 * Checking a person for a shift gives two lists: `blockers` (cannot be done: they already
 * work then, they are away…) and `warnings` (can be done, the manager should know: another
 * position, little rest, too many hours).
 */
const { coversShift } = require('./timeOff');

const STATUSES = ['pending_peer', 'pending_manager', 'approved', 'rejected', 'declined', 'cancelled'];
const OPEN = ['pending_peer', 'pending_manager'];
const TYPES = ['give', 'exchange', 'open'];
const MIN_REST_HOURS = 12;      // between two working days (Estatuto de los Trabajadores, art. 34.3)
const MAX_WEEK_HOURS = 40;      // ordinary weekly working time (art. 34.1)
const MIN_NOTICE_HOURS = 12;    // an employee cannot start a change closer than this to the shift

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const span = (start, end) => {
  const s = toMin(start);
  const e = toMin(end);
  return [s, e > s ? e : e + 1440];
};
const dayNumber = (date) => Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 86400000);
/** Start and end of a row as absolute minutes (an end before the start is past midnight). */
const absolute = (r) => {
  const base = dayNumber(r.date) * 1440;
  const [s, e] = span(r.start, r.end);
  return [base + s, base + e];
};

const overlap = (a, b) => {
  if (!a.start || !a.end || !b.start || !b.end) return false;
  const [s1, e1] = span(a.start, a.end);
  const [s2, e2] = span(b.start, b.end);
  return s1 < e2 && s2 < e1;
};

const hoursOf = (r) => { const [s, e] = span(r.start, r.end); return (e - s) / 60; };

/**
 * @param {object}   p.row           the shift { date, start, end, roleLabel }
 * @param {object}   p.taker         { firstName, status }
 * @param {string[]} p.positionNames names of the taker's positions
 * @param {object[]} p.sameDay       taker's other shifts that day  { date, start, end }
 * @param {object[]} p.nearby        taker's other shifts the day before and after
 * @param {object[]} p.week          taker's other shifts that week
 * @param {object[]} p.timeOff       taker's time off (approved ones block)
 * @returns {{ blockers: string[], warnings: string[] }}
 */
function evaluateTaker({ row, taker, positionNames = [], sameDay = [], nearby = [], week = [], timeOff = [] }) {
  const blockers = [];
  const warnings = [];
  const name = taker?.firstName || 'Esa persona';
  if (!taker || taker.status === 'inactive') return { blockers: ['Esa persona no está activa'], warnings };
  if (sameDay.some((s) => overlap(s, row))) blockers.push(`${name} ya trabaja a esa hora`);
  if (timeOff.some((t) => t.status === 'approved' && coversShift(t, row.date, row.start, row.end))) blockers.push(`${name} tiene una ausencia ese día`);
  if (blockers.length) return { blockers, warnings };

  if (row.roleLabel && positionNames.length && !positionNames.includes(row.roleLabel)) warnings.push(`Es de otro puesto (${row.roleLabel})`);

  const [rs, re] = absolute(row);
  const gaps = [...sameDay, ...nearby].map((o) => {
    const [os, oe] = absolute(o);
    return oe <= rs ? rs - oe : os >= re ? os - re : null;
  }).filter((g) => g !== null);
  if (gaps.some((g) => g < MIN_REST_HOURS * 60)) warnings.push(`Descansaría menos de ${MIN_REST_HOURS} h`);

  const total = week.reduce((n, r) => n + hoursOf(r), 0) + hoursOf(row);
  if (total > MAX_WEEK_HOURS) warnings.push(`Pasaría de ${MAX_WEEK_HOURS} h esa semana`);
  return { blockers, warnings };
}

/** The first reason someone cannot take the shift, or null. */
function whyCannotTake({ shift, taker, takerShifts = [], takerTimeOff = [] }) {
  return evaluateTaker({ row: shift, taker, sameDay: takerShifts, timeOff: takerTimeOff }).blockers[0] || null;
}

/** What a shift costs for the person who works it (monthly pay does not change with the shift). */
function costOf(row, comp, customPrice = null) {
  if (customPrice !== null && customPrice !== undefined && Number.isFinite(Number(customPrice))) return Number(Number(customPrice).toFixed(2));
  if (!comp) return 0;
  if (comp.paymentType === 'hourly') return Number((hoursOf(row) * Number(comp.baseAmount || 0)).toFixed(2));
  if (comp.paymentType === 'per_shift') return Number(Number(comp.baseAmount || 0).toFixed(2));
  return 0;
}

module.exports = { STATUSES, OPEN, TYPES, MIN_REST_HOURS, MAX_WEEK_HOURS, MIN_NOTICE_HOURS, evaluateTaker, whyCannotTake, costOf, overlap };
