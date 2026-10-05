/**
 * Shift swaps: an employee gives a shift away ("cédeme/cúbreme") to a named colleague
 * or to anyone. The colleague accepts, then the manager approves, and only then does
 * the shift change hands. Pure rules; the controller does the loading and saving.
 */
const { coversShift } = require('./timeOff');

const STATUSES = ['pending_peer', 'pending_manager', 'approved', 'rejected', 'declined', 'cancelled'];
const OPEN = ['pending_peer', 'pending_manager'];

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const span = (start, end) => {
  const s = toMin(start);
  const e = toMin(end);
  return [s, e > s ? e : e + 1440];
};
const overlap = (a, b) => {
  if (!a.start || !a.end || !b.start || !b.end) return false;
  const [s1, e1] = span(a.start, a.end);
  const [s2, e2] = span(b.start, b.end);
  return s1 < e2 && s2 < e1;
};

/**
 * Can `taker` work this shift? Returns null when yes, or the reason in Spanish.
 * @param {object} shift            { date, start, end }
 * @param {object[]} takerShifts    taker's other assignments that day: { start, end }
 * @param {object[]} takerTimeOff   taker's approved time off
 */
function whyCannotTake({ shift, takerShifts = [], takerTimeOff = [], taker }) {
  if (!taker || taker.status === 'inactive') return 'Esa persona no está activa';
  if (takerShifts.some((s) => overlap(s, shift))) return `${taker.firstName || 'Esa persona'} ya trabaja a esa hora`;
  if (takerTimeOff.some((t) => t.status === 'approved' && coversShift(t, shift.date, shift.start, shift.end))) {
    return `${taker.firstName || 'Esa persona'} tiene una ausencia ese día`;
  }
  return null;
}

module.exports = { STATUSES, OPEN, whyCannotTake, overlap };
