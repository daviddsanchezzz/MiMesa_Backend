/**
 * Per-customer numbers from their appointments: how often they come, when
 * they're due back, what they spend. Pure, shared by the dashboard and the
 * customer file.
 */
const DAY = 24 * 60 * 60 * 1000;
const DUE_MIN_DAYS = 21;
const DUE_SINGLE_VISIT_DAYS = 42;
const DUE_MAX_DAYS = 240; // older than this: probably lost, not "due"
const CANCELLED = new Set(['cancelled', 'no_show']);

const isLive = (b) => !CANCELLED.has(b.status);
const attended = (b, now) => isLive(b) && (b.status === 'completed' || b.status === 'checked_in' || new Date(b.end) <= now);

/** starts: Date[] of attended visits (any order). */
function rhythm(starts, now = new Date()) {
  const sorted = [...starts].map((d) => new Date(d)).sort((a, b) => a - b);
  if (!sorted.length) return { visits: 0, lastVisit: null, avgDays: null, expectedDays: null, daysSince: null, dueBack: false };
  const last = sorted[sorted.length - 1];
  const avgDays = sorted.length > 1 ? (last - sorted[0]) / DAY / (sorted.length - 1) : null;
  const expectedDays = avgDays ? Math.max(DUE_MIN_DAYS, avgDays * 1.2) : DUE_SINGLE_VISIT_DAYS;
  const daysSince = (now - last) / DAY;
  return {
    visits: sorted.length,
    lastVisit: last,
    avgDays: avgDays ? Math.round(avgDays) : null,
    expectedDays: Math.round(expectedDays),
    daysSince: Math.round(daysSince),
    dueBack: daysSince >= expectedDays && daysSince <= DUE_MAX_DAYS,
  };
}

function mostCommon(values) {
  const count = new Map();
  for (const v of values) if (v) count.set(v, (count.get(v) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/** Summary of one customer's bookings. */
function summarizeCustomer(bookings, now = new Date()) {
  const done = bookings.filter((b) => attended(b, now));
  const next = bookings.filter((b) => isLive(b) && new Date(b.start) > now).sort((a, b) => new Date(a.start) - new Date(b.start))[0] || null;
  const r = rhythm(done.map((b) => b.start), now);
  return {
    ...r,
    dueBack: r.dueBack && !next,
    nextVisit: next ? next.start : null,
    nextBookingId: next ? String(next._id) : null,
    spent: done.reduce((s, b) => s + (b.totalPrice || 0), 0),
    noShows: bookings.filter((b) => b.status === 'no_show').length,
    cancellations: bookings.filter((b) => b.status === 'cancelled').length,
    favouriteService: mostCommon(done.flatMap((b) => (b.segments || []).map((s) => s.serviceName))),
    favouriteStaffId: mostCommon(done.flatMap((b) => (b.segments || []).flatMap((s) => (s.resourceIds || []).map(String)))),
  };
}

module.exports = { rhythm, summarizeCustomer, isLive, attended, DUE_MAX_DAYS };
