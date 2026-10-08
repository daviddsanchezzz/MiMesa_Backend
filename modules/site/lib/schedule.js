/**
 * What the website says about opening, worked out from what the restaurant already defines for its
 * reservations — the turnos (comida, cena…), the vacations and the closure exceptions. Nothing is typed
 * twice. The customer times of a turno are used, never the staff times. Pure: the controller loads the data.
 *
 *   shift     { name, startTime, endTime, days: [0..6], startDate?, endDate? }
 *   vacation  { startDate, endDate, reason }
 *   exception { date, shiftName | '__all__', type, message }   (only type 'closed' matters here)
 */
const ALL_SHIFTS = '__all__';

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

const addDays = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Ranges sorted by opening; those that touch or overlap become one (13:00–16:00 + 16:00–17:00 = 13:00–17:00). */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.open.localeCompare(b.open));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const lastEnds = last && toMinutes(last.close) > toMinutes(last.open) ? toMinutes(last.close) : null; // a night range is left alone
    if (last && lastEnds !== null && toMinutes(r.open) <= lastEnds && toMinutes(r.close) > toMinutes(r.open)) {
      if (toMinutes(r.close) > lastEnds) last.close = r.close;
    } else out.push({ open: r.open, close: r.close });
  }
  return out;
}

/**
 * When the place closes for a turno, as the website says it: the last time a table can be booked plus how long
 * a table stays (reservationDuration, minutes). The turno's own end time is only the limit for booking, not the
 * moment the last customers leave. Without a duration configured the end time is kept.
 */
function serviceEnd(shift, duration) {
  const start = toMinutes(shift.startTime);
  const end = toMinutes(shift.endTime);
  const stay = Number(duration) || 0;
  if (!stay || end <= start) return shift.endTime;
  const specific = (shift.subShifts || []).map((x) => toMinutes(x.time)).filter((m) => Number.isFinite(m));
  const interval = Number(shift.interval) > 0 ? Number(shift.interval) : 30;
  // The slots are generated every `interval` from the start while they are before the end
  const last = specific.length ? Math.max(...specific) : start + Math.floor((end - start - 1) / interval) * interval;
  const total = (last + stay) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return total === 0 ? '24:00' : `${hh}:${mm}`;
}

const rangeOf = (s) => ({ open: s.startTime, close: s.endTime });
const isUsable = (s) => s.startTime && s.endTime && s.startTime !== s.endTime;
const hasDates = (s) => !!(s.startDate && s.endDate);

/** The regular week: turnos without dates, 7 days (0 = Sunday), no ranges = closed. */
function weeklyHours(shifts) {
  return [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    ranges: mergeRanges((shifts || []).filter((s) => isUsable(s) && !hasDates(s) && (s.days || []).includes(day)).map(rangeOf)),
  }));
}

/** Turnos that only run between two dates (summer hours, a Christmas menu service…). */
function seasonalShifts(shifts, today) {
  return (shifts || []).filter((s) => isUsable(s) && hasDates(s) && s.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map((s) => ({ name: s.name, from: s.startDate, to: s.endDate, days: s.days || [], open: s.startTime, close: s.endTime }));
}

const vacationOn = (vacations, date) => (vacations || []).find((v) => v.startDate <= date && date <= v.endDate) || null;

const appliesOn = (s, date, weekday) => isUsable(s) && (s.days || []).includes(weekday)
  && (!s.startDate || s.startDate <= date) && (!s.endDate || date <= s.endDate);

const closedException = (exceptions, s, date) => (exceptions || []).find((e) => e.type === 'closed' && e.date === date && (e.shiftName === ALL_SHIFTS || e.shiftName === s.name)) || null;

/** One day: the ranges served (after vacations and closures) and why nothing is served, if a closure is the reason. */
function dayOf({ shifts, vacations, exceptions }, date, weekday) {
  const vacation = vacationOn(vacations, date);
  if (vacation) return { ranges: [], reason: vacation.reason || '' };
  const planned = (shifts || []).filter((s) => appliesOn(s, date, weekday));
  const served = planned.filter((s) => !closedException(exceptions, s, date));
  const reason = planned.length && !served.length ? (closedException(exceptions, planned[0], date)?.message || '') : '';
  return { ranges: mergeRanges(served.map(rangeOf)), reason };
}

const coversNow = (r, minutes) => {
  const open = toMinutes(r.open);
  const close = toMinutes(r.close);
  return close > open ? minutes >= open && minutes < close : minutes >= open;
};

/** Open at `now` ({ date, minutes, weekday })? A range that closes after midnight keeps the place open into the next early morning. */
function isOpenNow(data, now) {
  if (dayOf(data, now.date, now.weekday).ranges.some((r) => coversNow(r, now.minutes))) return true;
  const yesterday = dayOf(data, addDays(now.date, -1), (now.weekday + 6) % 7);
  return yesterday.ranges.some((r) => toMinutes(r.close) < toMinutes(r.open) && now.minutes < toMinutes(r.close));
}

/** Closures still to come, soonest first: vacations and closure exceptions (a whole day, or just one turno). */
function upcomingClosures({ vacations, exceptions }, today, days = 180) {
  const limit = addDays(today, days);
  const list = [
    ...(vacations || []).filter((v) => v.endDate >= today && v.startDate <= limit).map((v) => ({ from: v.startDate, to: v.endDate, reason: v.reason || '', shift: null })),
    ...(exceptions || []).filter((e) => e.type === 'closed' && e.date >= today && e.date <= limit)
      .map((e) => ({ from: e.date, to: e.date, reason: e.message || '', shift: e.shiftName === ALL_SHIFTS ? null : e.shiftName })),
  ];
  return list.sort((a, b) => a.from.localeCompare(b.from));
}

/** { date, minutes, weekday } of an instant in a timezone. */
function localNow(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (t) => parts.find((p) => p.type === t).value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return { date, minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
}

/** Everything the website shows about the schedule, for the restaurant's "now". */
function build(data, now) {
  const today = dayOf(data, now.date, now.weekday);
  return {
    openingHours: weeklyHours(data.shifts),
    seasonal: seasonalShifts(data.shifts, now.date),
    today: { date: now.date, weekday: now.weekday, ranges: today.ranges, closed: today.ranges.length === 0, closureReason: today.reason, openNow: isOpenNow(data, now) },
    closures: upcomingClosures(data, now.date),
  };
}

module.exports = { serviceEnd, build, weeklyHours, seasonalShifts, dayOf, isOpenNow, upcomingClosures, localNow, mergeRanges, toMinutes, addDays, ALL_SHIFTS };
