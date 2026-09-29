/**
 * Availability engine. Pure functions: everything they need (service,
 * schedules, resources, busy intervals, "now") is passed in, so the whole
 * logic is unit-tested without a database.
 *
 * A time is free for a service when:
 *   1. the business is open for the whole service duration,
 *   2. for every required resource kind there are enough resources that are
 *      working then (own schedule, or business hours if they have none) and not
 *      busy (existing bookings + buffers),
 *   3. in 'pool' mode, the people already booked plus this party fit the pool,
 *   4. online bookings also respect minimum notice and max days ahead.
 */
const { zonedDateTimeToUtc } = require('../../../core/lib/timezone');
const { toHHMM, windowsForDate, intersect, contains, datesBetween, addDaysToDate } = require('./schedule');

const MIN = 60 * 1000;

function localToUtc(dateStr, minutes, tz) {
  if (minutes >= 1440) return zonedDateTimeToUtc(addDaysToDate(dateStr, 1), toHHMM(minutes - 1440), tz);
  return zonedDateTimeToUtc(dateStr, toHHMM(minutes), tz);
}

const idOf = (x) => String(x?._id ?? x);

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Builds the reusable context for one service on one business.
 * busy: [{ resourceId, start: Date, end: Date }] already including the buffers
 *       of the bookings that created them.
 * poolUsage: [{ start: Date, end: Date, partySize }] of this service.
 */
function createContext({
  service, timezone, businessSchedule, resources = [], resourceSchedules = {}, busy = [], poolUsage = [],
  now = new Date(), online = false,
}) {
  const busyByResource = new Map();
  for (const b of busy) {
    const k = idOf(b.resourceId);
    if (!busyByResource.has(k)) busyByResource.set(k, []);
    busyByResource.get(k).push(b);
  }
  return {
    service, timezone, businessSchedule, resources, resourceSchedules, busyByResource, poolUsage, now, online,
    windowCache: new Map(),
  };
}

function businessWindows(ctx, dateStr) {
  const key = `b|${dateStr}`;
  if (!ctx.windowCache.has(key)) ctx.windowCache.set(key, windowsForDate(ctx.businessSchedule, dateStr));
  return ctx.windowCache.get(key);
}

function resourceWindows(ctx, resource, dateStr) {
  const key = `${idOf(resource)}|${dateStr}`;
  if (!ctx.windowCache.has(key)) {
    const own = ctx.resourceSchedules[idOf(resource)];
    const biz = businessWindows(ctx, dateStr);
    ctx.windowCache.set(key, own ? intersect(windowsForDate(own, dateStr), biz) : biz);
  }
  return ctx.windowCache.get(key);
}

function candidatesFor(ctx, requirement, partySize, preferredId) {
  const allowed = (requirement.resourceIds || []).map(idOf);
  let list = ctx.resources.filter((r) =>
    r.kind === requirement.kind
    && r.active !== false
    && (!ctx.online || r.bookableOnline !== false)
    && (allowed.length === 0 || allowed.includes(idOf(r)))
    && (!requirement.matchPartySize || ((r.capacity || 1) >= partySize && (r.minCapacity || 1) <= partySize)));
  if (preferredId) list = list.filter((r) => idOf(r) === String(preferredId));
  return list.sort((a, b) => (requirement.matchPartySize ? (a.capacity || 1) - (b.capacity || 1) : 0)
    || (a.sortOrder || 0) - (b.sortOrder || 0)
    || idOf(a).localeCompare(idOf(b)));
}

function resourceIsFree(ctx, resource, dateStr, startMin, endMin, busyStart, busyEnd) {
  if (!contains(resourceWindows(ctx, resource, dateStr), startMin, endMin)) return false;
  const busy = ctx.busyByResource.get(idOf(resource)) || [];
  return !busy.some((b) => overlaps(busyStart, busyEnd, b.start, b.end));
}

/**
 * Checks one concrete start. Returns { ok: true, start, end, busyStart, busyEnd, assignments }
 * or { ok: false, reason }. `preferred` maps requirement index → resource id.
 */
function evaluateStart(ctx, dateStr, startMin, { partySize = 1, preferred = {}, extraBusy = [] } = {}) {
  const s = ctx.service;
  const endMin = startMin + s.durationMin;
  if (s.bookingMode === 'quote') return { ok: false, reason: 'quote_only' };
  const min = s.partySize?.min ?? 1;
  const max = s.partySize?.max ?? 1;
  if (partySize < min || partySize > max) return { ok: false, reason: 'party_size' };
  if (endMin > 1440) return { ok: false, reason: 'crosses_midnight' };
  if (!contains(businessWindows(ctx, dateStr), startMin, endMin)) return { ok: false, reason: 'closed' };

  const start = localToUtc(dateStr, startMin, ctx.timezone);
  const end = localToUtc(dateStr, endMin, ctx.timezone);
  const busyStart = new Date(start.getTime() - (s.bufferBeforeMin || 0) * MIN);
  const busyEnd = new Date(end.getTime() + (s.bufferAfterMin || 0) * MIN);

  if (ctx.online) {
    const ob = s.onlineBooking || {};
    if (ob.enabled === false) return { ok: false, reason: 'online_disabled' };
    if (start.getTime() < ctx.now.getTime() + (ob.minNoticeHours || 0) * 60 * MIN) return { ok: false, reason: 'notice' };
    const limit = ctx.now.getTime() + (ob.maxDaysAhead || 60) * 24 * 60 * MIN;
    if (start.getTime() > limit) return { ok: false, reason: 'too_far' };
  } else if (start.getTime() < ctx.now.getTime() - 24 * 60 * MIN) {
    return { ok: false, reason: 'past' };
  }

  if (s.capacityMode === 'pool') {
    const used = ctx.poolUsage
      .filter((u) => overlaps(start, end, u.start, u.end))
      .reduce((sum, u) => sum + (u.partySize || 1), 0);
    if (!s.poolCapacity || used + partySize > s.poolCapacity) return { ok: false, reason: 'pool_full' };
  }

  // Temporarily add extra busy intervals (earlier segments of the same booking).
  const restore = [];
  for (const b of extraBusy) {
    const k = idOf(b.resourceId);
    if (!ctx.busyByResource.has(k)) ctx.busyByResource.set(k, []);
    ctx.busyByResource.get(k).push(b);
    restore.push(k);
  }
  try {
    const used = new Set();
    const assignments = [];
    const reqs = s.requirements || [];
    for (let i = 0; i < reqs.length; i++) {
      const req = reqs[i];
      const chosen = [];
      for (const r of candidatesFor(ctx, req, partySize, preferred[i])) {
        if (chosen.length >= (req.count || 1)) break;
        if (used.has(idOf(r))) continue;
        if (resourceIsFree(ctx, r, dateStr, startMin, endMin, busyStart, busyEnd)) {
          chosen.push(idOf(r));
          used.add(idOf(r));
        }
      }
      if (chosen.length < (req.count || 1)) {
        if (!req.optional) return { ok: false, reason: 'no_resource', requirement: i };
        chosen.forEach((id) => used.delete(id));
        assignments.push([]);
      } else {
        assignments.push(chosen);
      }
    }
    return { ok: true, start, end, busyStart, busyEnd, assignments };
  } finally {
    for (const k of restore) ctx.busyByResource.get(k).pop();
  }
}

/**
 * All bookable starts between two local dates (inclusive), on the service's
 * slot grid aligned to each opening window.
 */
function findSlots(ctx, { from, to, partySize = 1, preferred = {}, maxDays = 62 } = {}) {
  const slots = [];
  const step = ctx.service.slotIntervalMin || 15;
  for (const dateStr of datesBetween(from, to, maxDays)) {
    const seen = new Set();
    for (const [ws, we] of businessWindows(ctx, dateStr)) {
      for (let m = ws; m + ctx.service.durationMin <= we; m += step) {
        if (seen.has(m)) continue;
        seen.add(m);
        const r = evaluateStart(ctx, dateStr, m, { partySize, preferred });
        if (r.ok) slots.push({ date: dateStr, time: toHHMM(m), start: r.start, end: r.end, resourceIds: r.assignments });
      }
    }
  }
  return slots;
}

module.exports = { createContext, evaluateStart, findSlots, localToUtc };
