/**
 * Days off, holidays and "I can't work then" of the restaurant staff.
 * Dates 'YYYY-MM-DD', times 'HH:MM'. Pure.
 */
const TYPES = ['vacation', 'day_off', 'unavailable'];
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const TYPE_LABEL = { vacation: 'Vacaciones', day_off: 'Día libre', unavailable: 'No disponible' };

const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const isTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** Validates the body of a request and returns the clean fields, or { error }. */
function cleanTimeOff(body = {}) {
  const type = TYPES.includes(body.type) ? body.type : null;
  if (!type) return { error: 'Tipo de ausencia no válido' };
  if (!isDate(body.from)) return { error: 'La fecha de inicio no es válida' };
  const to = body.to || body.from;
  if (!isDate(to)) return { error: 'La fecha de fin no es válida' };
  if (to < body.from) return { error: 'La fecha de fin no puede ser anterior a la de inicio' };
  const fromTime = body.fromTime || '';
  const toTime = body.toTime || '';
  if ((fromTime && !isTime(fromTime)) || (toTime && !isTime(toTime))) return { error: 'La hora no es válida' };
  if ((fromTime || toTime) && body.from !== to) return { error: 'Un tramo horario solo puede ser de un día' };
  if (fromTime && toTime && fromTime === toTime) return { error: 'El tramo horario no es válido' };
  return { value: { type, from: body.from, to, fromTime, toTime, note: String(body.note || '').trim().slice(0, 300) } };
}

/** Does this time off cover that day (and, if it is a partial day, that time range)? */
function coversShift(timeOff, date, start, end) {
  if (date < timeOff.from || date > timeOff.to) return false;
  if (!timeOff.fromTime && !timeOff.toTime) return true;
  if (!isTime(start) || !isTime(end)) return true; // cannot tell: warn anyway
  const a = timeOff.fromTime ? toMin(timeOff.fromTime) : 0;
  const b = timeOff.toTime ? toMin(timeOff.toTime) : 1440;
  const s = toMin(start);
  const e = toMin(end) > s ? toMin(end) : toMin(end) + 1440;
  return s < b && a < e;
}

/** Two periods of the same person that share any day (and time). */
function overlapsOther(a, b) {
  if (a.to < b.from || b.to < a.from) return false;
  const partial = (x) => x.fromTime || x.toTime;
  if (!partial(a) || !partial(b)) return true;
  const [a1, a2] = [a.fromTime ? toMin(a.fromTime) : 0, a.toTime ? toMin(a.toTime) : 1440];
  const [b1, b2] = [b.fromTime ? toMin(b.fromTime) : 0, b.toTime ? toMin(b.toTime) : 1440];
  return a1 < b2 && b1 < a2;
}

const describe = (t) => {
  const range = t.from === t.to ? t.from : `${t.from} → ${t.to}`;
  const hours = t.fromTime || t.toTime ? ` (${t.fromTime || '00:00'}–${t.toTime || '24:00'})` : '';
  return `${TYPE_LABEL[t.type] || t.type} · ${range}${hours}`;
};

module.exports = { TYPES, STATUSES, TYPE_LABEL, cleanTimeOff, coversShift, overlapsOther, describe, isDate };
