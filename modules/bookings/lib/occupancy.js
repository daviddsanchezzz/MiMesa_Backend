/**
 * Splits a busy interval into fixed 5-minute cells. Each (resource, cell)
 * pair is stored once with a unique index, so the database itself rejects a
 * second booking of the same resource at the same time.
 *
 * All starts, durations and buffers are multiples of 5 minutes (enforced by
 * the API), so adjacent bookings never share a cell.
 */
const CELL_MIN = 5;
const CELL_MS = CELL_MIN * 60 * 1000;

function cellsFor(busyStart, busyEnd) {
  const first = Math.floor(busyStart.getTime() / CELL_MS) * CELL_MS;
  const cells = [];
  for (let t = first; t < busyEnd.getTime(); t += CELL_MS) cells.push(new Date(t));
  return cells;
}

function isAligned(minutes) {
  return Number.isInteger(minutes) && minutes % CELL_MIN === 0;
}

module.exports = { CELL_MIN, cellsFor, isAligned };
