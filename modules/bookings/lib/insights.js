/**
 * Estadísticas for appointment businesses: which services bring the money,
 * when the agenda is busy, who the customers are and how many appointments
 * fall through. Pure, like stats.js: the service loads the bookings (a year
 * of history is enough to tell new customers from returning ones) and hands
 * them in. Money is in cents.
 */
const { rhythm, isLive, attended } = require('./customers');
const { customerKey } = require('./stats');
const { addDaysToDate, datesBetween } = require('./schedule');

const SOURCES = ['online', 'phone', 'walk_in', 'staff'];
const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const TOP_SERVICES = 8;
const LAPSED_TOP = 5;

const idOf = (x) => String(x?._id ?? x);

function makeLocal(tz) {
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', hour12: false });
  const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    date: (d) => dateFmt.format(new Date(d)),
    // weekday 0 = Monday, local hour 0-23
    when: (d) => {
      const parts = Object.fromEntries(partsFmt.formatToParts(new Date(d)).map((p) => [p.type, p.value]));
      return { weekday: DOW[parts.weekday] ?? 0, hour: Number(parts.hour) % 24 };
    },
  };
}

/** Length-matched period right before [from, to]. */
function previousPeriod(from, to) {
  const days = datesBetween(from, to, 400).length;
  return { from: addDaysToDate(from, -days), to: addDaysToDate(from, -1) };
}

function computeInsights({ now = new Date(), timezone: tz, from, to, compare = null, bookings = [] }) {
  const local = makeLocal(tz);
  // The period to compare with: the caller's (e.g. the previous calendar month) or the same length right before
  const prev = compare || previousPeriod(from, to);
  const dated = bookings.map((b) => ({ b, date: local.date(b.start) }));
  const within = (a, z) => dated.filter((x) => x.date >= a && x.date <= z).map((x) => x.b);

  const current = within(from, to);
  const before = within(prev.from, prev.to);

  // First live booking of each customer, ever: separates new from returning.
  const firstSeen = new Map();
  for (const { b, date } of dated) {
    if (!isLive(b)) continue;
    const k = customerKey(b);
    if (!firstSeen.has(k) || date < firstSeen.get(k)) firstSeen.set(k, date);
  }
  const countNew = (list, a) => {
    const keys = new Set(list.filter(isLive).map(customerKey));
    let fresh = 0;
    for (const k of keys) if (firstSeen.get(k) >= a) fresh += 1;
    return { fresh, total: keys.size };
  };

  const summary = (list, a) => {
    const done = list.filter((b) => attended(b, now));
    const billed = done.reduce((s, b) => s + (b.totalPrice || 0), 0);
    const scheduled = list.filter((b) => b.status !== 'pending');
    const cancelled = scheduled.filter((b) => b.status === 'cancelled').length;
    const noShow = scheduled.filter((b) => b.status === 'no_show').length;
    const c = countNew(list, a);
    return {
      appointments: done.length,
      billed,
      averageTicket: done.length ? Math.round(billed / done.length) : 0,
      customers: c.total,
      newCustomers: c.fresh,
      returningCustomers: c.total - c.fresh,
      scheduled: scheduled.length,
      cancelled,
      noShow,
    };
  };
  const cur = summary(current, from);
  const prevSummary = summary(before, prev.from);

  // Services: what attended appointments are worth, per service.
  const services = new Map();
  let serviceTotal = 0;
  for (const b of current) {
    if (!attended(b, now)) continue;
    for (const seg of b.segments || []) {
      const k = idOf(seg.serviceId);
      const row = services.get(k) || { id: k, name: seg.serviceName || 'Servicio', count: 0, revenue: 0 };
      row.count += 1;
      row.revenue += seg.price || 0;
      serviceTotal += seg.price || 0;
      services.set(k, row);
    }
  }
  const topServices = [...services.values()].sort((a, b) => b.revenue - a.revenue || b.count - a.count)
    .slice(0, TOP_SERVICES)
    .map((s) => ({ ...s, share: serviceTotal ? Math.round((s.revenue / serviceTotal) * 100) : 0 }));

  // When: appointments that were kept (not cancelled / no-show), by weekday and local hour.
  const byWeekday = WEEKDAYS.map((day) => ({ day, appointments: 0 }));
  const hours = new Map();
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  for (const b of current) {
    if (!isLive(b) || b.status === 'pending') continue;
    const w = local.when(b.start);
    byWeekday[w.weekday].appointments += 1;
    hours.set(w.hour, (hours.get(w.hour) || 0) + 1);
    bySource[SOURCES.includes(b.source) ? b.source : 'staff'] += 1;
  }
  const byHour = [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, appointments]) => ({ hour, appointments }));

  // Customers who are overdue for a visit (same rule as the dashboard).
  const visits = new Map();
  for (const b of bookings) {
    const k = customerKey(b);
    const c = visits.get(k) || { name: b.guestName, phone: b.guestPhone || '', customerId: b.customerId ? idOf(b.customerId) : null, starts: [], future: false };
    if (isLive(b) && new Date(b.start) > now) c.future = true;
    if (attended(b, now)) c.starts.push(new Date(b.start));
    visits.set(k, c);
  }
  const lapsed = [];
  for (const c of visits.values()) {
    if (c.future || !c.starts.length) continue;
    const r = rhythm(c.starts, now);
    if (r.dueBack) lapsed.push({ name: c.name, phone: c.phone, customerId: c.customerId, daysSince: r.daysSince, visits: r.visits });
  }
  lapsed.sort((a, b) => b.visits - a.visits || a.daysSince - b.daysSince);

  const rate = (n, total) => (total ? Math.round((n / total) * 100) : 0);
  return {
    range: { from, to },
    previousRange: prev,
    summary: cur,
    previous: prevSummary,
    services: topServices,
    byWeekday,
    byHour,
    sources: SOURCES.map((key) => ({ key, appointments: bySource[key] })),
    customers: {
      total: cur.customers, new: cur.newCustomers, returning: cur.returningCustomers,
      lapsed: { count: lapsed.length, top: lapsed.slice(0, LAPSED_TOP) },
    },
    cancellations: {
      cancelled: cur.cancelled, noShow: cur.noShow, scheduled: cur.scheduled,
      cancelledRate: rate(cur.cancelled, cur.scheduled), noShowRate: rate(cur.noShow, cur.scheduled),
    },
  };
}

module.exports = { computeInsights, previousPeriod };
