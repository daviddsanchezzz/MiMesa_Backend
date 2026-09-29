/**
 * Pure helpers to turn a Schedule (weekly rules + date overrides) into the
 * open windows of a given local date. Times are minutes since local midnight.
 */

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

function toHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 0 = Sunday … 6 = Saturday, for a 'YYYY-MM-DD' calendar date.
function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDaysToDate(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function datesBetween(from, to, max = 400) {
  const out = [];
  for (let d = from; d <= to && out.length < max; d = addDaysToDate(d, 1)) out.push(d);
  return out;
}

// Sorts and merges overlapping/adjacent windows.
function normalize(windows) {
  const sorted = windows
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Open windows of `schedule` on `dateStr`. The last override covering the
 * date wins: closed → no windows; windows → exactly those; otherwise the
 * weekly rules for that weekday apply.
 */
function windowsForDate(schedule, dateStr) {
  if (!schedule) return [];
  const overrides = (schedule.overrides || []).filter((o) => o.from <= dateStr && dateStr <= o.to);
  const override = overrides[overrides.length - 1];
  if (override) {
    if (override.closed) return [];
    if (Array.isArray(override.windows)) {
      return normalize(override.windows.map((w) => [toMinutes(w.start), toMinutes(w.end)]));
    }
  }
  const dow = dayOfWeek(dateStr);
  return normalize((schedule.rules || [])
    .filter((r) => (r.days || []).includes(dow))
    .map((r) => [toMinutes(r.start), toMinutes(r.end)]));
}

function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]);
    const e = Math.min(a[i][1], b[j][1]);
    if (e > s) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

function contains(windows, start, end) {
  return windows.some(([s, e]) => s <= start && end <= e);
}

module.exports = {
  toMinutes, toHHMM, dayOfWeek, addDaysToDate, datesBetween, normalize, windowsForDate, intersect, contains,
};
