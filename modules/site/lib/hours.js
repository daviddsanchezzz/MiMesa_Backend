/**
 * Opening hours as the website shows them. Pure: given the saved hours, the closures and "now" in the
 * restaurant's timezone ({ date: 'YYYY-MM-DD', minutes, weekday }), say whether it is open, closed today
 * and which closures are coming.
 */
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

const rangesOf = (hours, weekday) => (hours || []).find((d) => d.day === weekday)?.ranges || [];

/** The closure covering `date`, if any. */
const closureOn = (closures, date) => (closures || []).find((c) => c.from <= date && date <= c.to) || null;

const addDays = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Open at this moment? A range whose close is before its open (20:00–01:00) or "24:00" runs past
 * midnight: it also counts for the early hours of the next day.
 */
function isOpenNow(hours, closures, now) {
  const yesterday = (now.weekday + 6) % 7;
  const yesterdayDate = addDays(now.date, -1);

  if (!closureOn(closures, now.date)) {
    for (const r of rangesOf(hours, now.weekday)) {
      const open = toMinutes(r.open);
      const close = toMinutes(r.close);
      if (close > open ? now.minutes >= open && now.minutes < close : now.minutes >= open) return true;
    }
  }
  // What yesterday's late ranges still cover this morning (unless yesterday was a closure)
  if (!closureOn(closures, yesterdayDate)) {
    for (const r of rangesOf(hours, yesterday)) {
      const open = toMinutes(r.open);
      const close = toMinutes(r.close);
      if (close < open && now.minutes < close) return true;
    }
  }
  return false;
}

/** Closures that have not ended yet, soonest first, within `days` from today. */
function upcomingClosures(closures, today, days = 180) {
  const limit = addDays(today, days);
  return (closures || []).filter((c) => c.to >= today && c.from <= limit).sort((a, b) => a.from.localeCompare(b.from));
}

/** { date, minutes, weekday } of an instant in a timezone. */
function localNow(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (t) => parts.find((p) => p.type === t).value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return { date, minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
}

module.exports = { toMinutes, rangesOf, closureOn, isOpenNow, upcomingClosures, localNow, addDays };
