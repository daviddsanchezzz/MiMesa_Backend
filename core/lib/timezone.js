const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Europe/Madrid';

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function businessTimezone(business) {
  return isValidTimezone(business?.timezone) ? business.timezone : DEFAULT_TIMEZONE;
}

// Offset (ms) of `tz` from UTC at the given instant.
function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// Converts a wall-clock 'YYYY-MM-DD' + 'HH:MM' in `tz` to the real instant (Date).
function zonedDateTimeToUtc(dateStr, timeStr, tz = DEFAULT_TIMEZONE) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm || 0);
  let ts = wallAsUtc - tzOffsetMs(wallAsUtc, tz);
  const corrected = wallAsUtc - tzOffsetMs(ts, tz); // handles DST boundaries
  if (corrected !== ts) ts = corrected;
  return new Date(ts);
}

// Today's date ('YYYY-MM-DD') as seen in `tz`.
function dateInTimezone(date, tz = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function todayInTimezone(tz = DEFAULT_TIMEZONE) {
  return dateInTimezone(new Date(), tz);
}

// Current wall-clock time ('HH:MM') in `tz`.
function nowTimeInTimezone(tz = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
}

module.exports = { DEFAULT_TIMEZONE, isValidTimezone, businessTimezone, zonedDateTimeToUtc, dateInTimezone, todayInTimezone, nowTimeInTimezone };
