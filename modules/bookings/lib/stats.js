/**
 * Business dashboard numbers for appointment businesses. Pure: the service
 * loads the bookings, staff and schedules and passes them in, so every figure
 * is unit-tested without a database.
 *
 * Money is in cents. "Attended" means the customer came (or the appointment
 * is in the past and nobody marked it as cancelled or no-show): most small
 * businesses never tick "completed".
 */
const { windowsForDate, intersect, addDaysToDate } = require('./schedule');
const { localToUtc } = require('./availability');
const { rhythm } = require('./customers');

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const CANCELLED = new Set(['cancelled', 'no_show']);
const MIN_GAP_MIN = 30;

const idOf = (x) => String(x?._id ?? x);
const isLive = (b) => !CANCELLED.has(b.status);

function customerKey(b) {
  if (b.customerId) return `c:${idOf(b.customerId)}`;
  if (b.guestEmail) return `e:${String(b.guestEmail).toLowerCase()}`;
  if (b.guestPhone) return `p:${String(b.guestPhone).replace(/\D/g, '').slice(-9)}`;
  return `n:${String(b.guestName || '').trim().toLowerCase()}`;
}

/**
 * Per-call helpers with caches: formatting dates in a timezone is slow, and
 * the dashboard asks the same questions thousands of times.
 */
function makeClock(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayStarts = new Map();
  const localDate = (d) => fmt.format(new Date(d));
  const dayStart = (dateStr) => {
    if (!dayStarts.has(dateStr)) dayStarts.set(dateStr, localToUtc(dateStr, 0, tz).getTime());
    return dayStarts.get(dateStr);
  };
  const minutesOfDay = (date, dateStr) => Math.round((new Date(date).getTime() - dayStart(dateStr)) / MIN);
  return { localDate, minutesOfDay };
}

/** { 'staffId|YYYY-MM-DD': [[startMin, endMin], ...] } for live bookings. */
function indexSegments(bookings, clock, fromDate) {
  const index = new Map();
  for (const b of bookings) {
    if (!isLive(b)) continue;
    for (const seg of b.segments || []) {
      const d = clock.localDate(seg.start);
      if (d < fromDate) continue;
      const iv = [clock.minutesOfDay(seg.start, d), clock.minutesOfDay(seg.end, d)];
      for (const r of seg.resourceIds || []) {
        const k = `${idOf(r)}|${d}`;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(iv);
      }
    }
  }
  for (const list of index.values()) list.sort((x, y) => x[0] - y[0]);
  return index;
}

function staffWindows(staff, dateStr, businessSchedule, resourceSchedules) {
  const biz = windowsForDate(businessSchedule, dateStr);
  const own = resourceSchedules[idOf(staff)];
  return own ? intersect(windowsForDate(own, dateStr), biz) : biz;
}

function overlapMin(windows, a, b) {
  let total = 0;
  for (const [s, e] of windows) total += Math.max(0, Math.min(e, b) - Math.max(s, a));
  return total;
}

function occupancy({ staff, dates, index, businessSchedule, resourceSchedules }) {
  let open = 0;
  let booked = 0;
  for (const s of staff) {
    for (const d of dates) {
      const win = staffWindows(s, d, businessSchedule, resourceSchedules);
      const dayOpen = win.reduce((acc, [a, b]) => acc + (b - a), 0);
      let dayBooked = 0;
      for (const [a, b] of index.get(`${idOf(s)}|${d}`) || []) dayBooked += overlapMin(win, a, b);
      open += dayOpen;
      booked += Math.min(dayBooked, dayOpen);
    }
  }
  return { openMin: open, bookedMin: booked, rate: open ? Math.round((booked / open) * 100) : null };
}

/** Free gaps of at least MIN_GAP_MIN left today, from now on. */
function freeGapsToday({ staff, today, nowMin, index, businessSchedule, resourceSchedules }) {
  const gaps = [];
  for (const s of staff) {
    const win = staffWindows(s, today, businessSchedule, resourceSchedules);
    const busy = index.get(`${idOf(s)}|${today}`) || [];
    for (const [ws, we] of win) {
      let cursor = Math.max(ws, Math.ceil(nowMin / 15) * 15);
      for (const [bs, be] of busy) {
        if (be <= cursor || bs >= we) continue;
        if (bs - cursor >= MIN_GAP_MIN) gaps.push({ resourceId: idOf(s), name: s.name, startMin: cursor, endMin: bs });
        cursor = Math.max(cursor, be);
      }
      if (we - cursor >= MIN_GAP_MIN) gaps.push({ resourceId: idOf(s), name: s.name, startMin: cursor, endMin: we });
    }
  }
  return gaps.sort((a, b) => a.startMin - b.startMin);
}

function sum(list, f) { return list.reduce((acc, x) => acc + (f(x) || 0), 0); }

/**
 * @param {object} p
 * @param {Date}   p.now
 * @param {string} p.timezone
 * @param {Array}  p.staff            active staff resources
 * @param {object} p.businessSchedule
 * @param {object} p.resourceSchedules  { [resourceId]: schedule }
 * @param {Array}  p.bookings         every booking from ~1 year ago to next week
 */
function computeStats({ now, timezone: tz, staff = [], businessSchedule = null, resourceSchedules = {}, bookings = [] }) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const tomorrow = addDaysToDate(today, 1);
  const monthStart = `${today.slice(0, 8)}01`;
  const prevMonthStart = (() => {
    const [y, m] = today.split('-').map(Number);
    const pm = m === 1 ? 12 : m - 1;
    return `${m === 1 ? y - 1 : y}-${String(pm).padStart(2, '0')}-01`;
  })();
  const dayOfMonth = Number(today.slice(8, 10));
  const prevSameDay = (() => {
    const [py, pm] = prevMonthStart.split('-').map(Number);
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    return `${prevMonthStart.slice(0, 8)}${String(Math.min(dayOfMonth, last)).padStart(2, '0')}`;
  })();
  const clock = makeClock(tz);
  const nowMin = clock.minutesOfDay(now, today);
  const startDate = new Map(bookings.map((b) => [b, clock.localDate(b.start)]));
  const localDate = (b) => startDate.get(b);
  const index = indexSegments(bookings, clock, monthStart);
  const attended = (b) => isLive(b) && (b.status === 'completed' || b.status === 'checked_in' || new Date(b.end) <= now);
  const ctx = { index, businessSchedule, resourceSchedules };

  const byDate = (d) => bookings.filter((b) => localDate(b) === d);
  const todays = byDate(today);
  const liveToday = todays.filter(isLive);
  const tomorrows = byDate(tomorrow).filter(isLive).sort((a, b) => new Date(a.start) - new Date(b.start));

  // ── Next 7 days ──
  const weekDates = Array.from({ length: 7 }, (_, i) => addDaysToDate(today, i));
  const week = occupancy({ staff, dates: weekDates, bookings, ...ctx });
  const weekBookings = bookings.filter((b) => isLive(b) && weekDates.includes(localDate(b)));

  // ── Month to date ──
  const inMonth = bookings.filter((b) => { const d = localDate(b); return d >= monthStart && d <= today; });
  const monthDone = inMonth.filter((b) => attended(b));
  const prevDone = bookings.filter((b) => { const d = localDate(b); return d >= prevMonthStart && d <= prevSameDay && attended(b); });
  const noShows = inMonth.filter((b) => b.status === 'no_show');
  const cancelled = inMonth.filter((b) => b.status === 'cancelled');
  const cancelledInTime = cancelled.filter((b) => b.cancelledAt && new Date(b.start) - new Date(b.cancelledAt) >= DAY);
  const reminded = monthDone.filter((b) => b.reminderSentAt && new Date(b.reminderSentAt).getTime() > 0);
  const online = inMonth.filter((b) => isLive(b) && b.source === 'online');

  // ── Team ──
  const monthDates = [];
  for (let d = monthStart; d <= today; d = addDaysToDate(d, 1)) monthDates.push(d);
  const team = staff.map((s) => {
    const sid = idOf(s);
    let count = 0;
    let revenue = 0;
    for (const b of monthDone) {
      let mine = false;
      for (const seg of b.segments || []) {
        const staffIds = (seg.resourceIds || []).map(idOf).filter((r) => staff.some((x) => idOf(x) === r));
        if (staffIds.includes(sid)) { mine = true; revenue += Math.round((seg.price || 0) / staffIds.length); }
      }
      if (mine) count++;
    }
    const occ = occupancy({ staff: [s], dates: monthDates, bookings, ...ctx });
    const occWeek = occupancy({ staff: [s], dates: weekDates, bookings, ...ctx });
    return { id: sid, name: s.name, color: s.color || null, appointments: count, revenue, occupancy: occ.rate, weekOccupancy: occWeek.rate };
  });

  // ── Services ──
  const services = new Map();
  for (const b of monthDone) {
    for (const seg of b.segments || []) {
      const k = idOf(seg.serviceId);
      const cur = services.get(k) || { id: k, name: seg.serviceName || 'Servicio', count: 0, revenue: 0 };
      cur.count += 1; cur.revenue += seg.price || 0;
      services.set(k, cur);
    }
  }
  const monthRevenue = sum(monthDone, (b) => b.totalPrice);
  const topServices = [...services.values()].sort((a, b) => b.revenue - a.revenue || b.count - a.count).slice(0, 3)
    .map((s) => ({ ...s, share: monthRevenue ? Math.round((s.revenue / monthRevenue) * 100) : 0 }));

  // ── Customers ──
  const visits = new Map(); // key → { name, phone, email, starts: [attended starts], future: bool, firstStart }
  for (const b of bookings) {
    const k = customerKey(b);
    const c = visits.get(k) || { key: k, name: b.guestName, phone: b.guestPhone || '', email: b.guestEmail || '', customerId: b.customerId ? idOf(b.customerId) : null, starts: [], future: false, first: null };
    const start = new Date(b.start);
    if (isLive(b) && start > now) c.future = true;
    if (attended(b)) c.starts.push(start);
    if (isLive(b) && (!c.first || start < c.first)) c.first = start;
    visits.set(k, c);
  }
  const monthKeys = new Set(inMonth.filter(isLive).map(customerKey));
  let newCustomers = 0;
  for (const k of monthKeys) {
    const c = visits.get(k);
    if (c && c.first && clock.localDate(c.first) >= monthStart) newCustomers++;
  }
  const overdue = [];
  for (const c of visits.values()) {
    if (c.future || !c.starts.length) continue;
    const r = rhythm(c.starts, now);
    if (r.dueBack) {
      overdue.push({ name: c.name, phone: c.phone, email: c.email, customerId: c.customerId, lastVisit: r.lastVisit, daysSince: r.daysSince, visits: r.visits });
    }
  }
  overdue.sort((a, b) => b.visits - a.visits || a.daysSince - b.daysSince);

  const pending = bookings.filter((b) => b.status === 'pending' && new Date(b.start) > now)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  return {
    today: {
      date: today,
      appointments: liveToday.length,
      attended: liveToday.filter((b) => attended(b)).length,
      remaining: liveToday.filter((b) => new Date(b.start) > now).length,
      pending: todays.filter((b) => b.status === 'pending').length,
      expectedRevenue: sum(liveToday, (b) => b.totalPrice),
    },
    tomorrow: {
      date: tomorrow,
      appointments: tomorrows.length,
      firstStart: tomorrows[0]?.start || null,
      expectedRevenue: sum(tomorrows, (b) => b.totalPrice),
    },
    week: {
      from: today,
      to: weekDates[6],
      appointments: weekBookings.length,
      occupancy: week.rate,
      freeHours: Math.round((week.openMin - week.bookedMin) / 60),
      expectedRevenue: sum(weekBookings, (b) => b.totalPrice),
    },
    actions: {
      pendingRequests: { count: pending.length, next: pending[0] ? { id: idOf(pending[0]._id), start: pending[0].start, name: pending[0].guestName } : null },
      freeGapsToday: freeGapsToday({ staff, today, nowMin, bookings, ...ctx }).slice(0, 4),
      overdueCustomers: { count: overdue.length, top: overdue.slice(0, 5) },
    },
    money: {
      monthStart,
      revenue: monthRevenue,
      previousRevenue: sum(prevDone, (b) => b.totalPrice),
      remindedAttended: { count: reminded.length, amount: sum(reminded, (b) => b.totalPrice) },
      onlineBookings: { count: online.length, amount: sum(online, (b) => b.totalPrice) },
      cancelledInTime: { count: cancelledInTime.length },
      cancellations: { count: cancelled.length },
      noShows: { count: noShows.length, amount: sum(noShows, (b) => b.totalPrice) },
    },
    team,
    topServices,
    customers: {
      month: monthKeys.size,
      new: newCustomers,
      returning: monthKeys.size - newCustomers,
      onlineShare: inMonth.filter(isLive).length ? Math.round((online.length / inMonth.filter(isLive).length) * 100) : null,
    },
  };
}

module.exports = { computeStats, customerKey, freeGapsToday, occupancy };
