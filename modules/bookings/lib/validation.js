/**
 * Input validation for the bookings API. Each function returns a clean
 * object with only the allowed fields, or throws a 400 BookingError.
 */
const mongoose = require('mongoose');
const { BookingError } = require('./errors');
const { isAligned } = require('./occupancy');
const { toMinutes } = require('./schedule');
const { checkImageDataUrl } = require('../../../core/lib/images');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_OR_24 = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const KINDS = ['staff', 'space', 'equipment'];

const bad = (msg) => { throw new BookingError(400, msg, 'BAD_REQUEST'); };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function str(v, name, { max = 200, required = false } = {}) {
  if (v === undefined || v === null) { if (required) bad(`${name} es obligatorio`); return undefined; }
  if (typeof v !== 'string') bad(`${name} no es válido`);
  const t = v.trim();
  if (required && !t) bad(`${name} es obligatorio`);
  if (t.length > max) bad(`${name} es demasiado largo`);
  return t;
}

function int(v, name, { min = 0, max = 1e9, step5 = false } = {}) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${name} no es válido`);
  if (step5 && !isAligned(n)) bad(`${name} debe ser múltiplo de 5`);
  return n;
}

function bool(v, name) {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') bad(`${name} no es válido`);
  return v;
}

function objectId(v, name) {
  if (typeof v !== 'string' || !mongoose.isValidObjectId(v)) bad(`${name} no es válido`);
  return v;
}

function date(v, name) {
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) bad(`${name} no es una fecha válida`);
  return v;
}

function dateRange(query, { maxDays }) {
  const from = date(query.from, 'from');
  const to = query.to === undefined ? from : date(query.to, 'to');
  if (to < from) bad('La fecha final es anterior a la inicial');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days > maxDays) bad(`El rango máximo es de ${maxDays} días`);
  return { from, to };
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const MAX_PHOTO_CHARS = 150 * 1024;

/** A small image sent as a data URL ('' or null removes it). */
function imageDataUrl(value, label, maxChars) {
  const r = checkImageDataUrl(value, { label, maxChars });
  if (r.error) bad(r.error);
  return r.value;
}

function resourceInput(body, { partial = false } = {}) {
  const out = clean({
    kind: body.kind,
    name: str(body.name, 'El nombre', { max: 100, required: !partial }),
    capacity: int(body.capacity, 'La capacidad', { min: 1, max: 500 }),
    minCapacity: int(body.minCapacity, 'La capacidad mínima', { min: 1, max: 500 }),
    bookableOnline: bool(body.bookableOnline, 'bookableOnline'),
    sortOrder: int(body.sortOrder, 'El orden', { min: 0, max: 10000 }),
    active: bool(body.active, 'active'),
    parentId: body.parentId === null ? null : (body.parentId !== undefined ? objectId(body.parentId, 'parentId') : undefined),
    staffEmployeeId: body.staffEmployeeId === null ? null : (body.staffEmployeeId !== undefined ? objectId(body.staffEmployeeId, 'staffEmployeeId') : undefined),
  });
  if (!partial && !KINDS.includes(body.kind)) bad('El tipo de recurso no es válido');
  if (partial && has(body, 'kind')) bad('El tipo de recurso no se puede cambiar');
  if (has(body, 'color')) {
    if (body.color === null || body.color === '') out.color = null;
    else if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) out.color = body.color.toLowerCase();
    else bad('El color no es válido');
  }
  if (has(body, 'photo')) out.photo = imageDataUrl(body.photo, 'La foto', MAX_PHOTO_CHARS);
  if (has(body, 'userId')) {
    if (body.userId === null || body.userId === '') out.userId = null;
    else if (typeof body.userId === 'string' && body.userId.length <= 100) out.userId = body.userId;
    else bad('El usuario no es válido');
  }
  if (has(body, 'attributes')) {
    if (typeof body.attributes !== 'object' || Array.isArray(body.attributes) || JSON.stringify(body.attributes).length > 4000) bad('attributes no es válido');
    out.attributes = body.attributes;
  }
  if (out.capacity && out.minCapacity && out.minCapacity > out.capacity) bad('La capacidad mínima supera la capacidad');
  return out;
}

function requirementInput(r, i) {
  if (!r || typeof r !== 'object') bad(`Requisito ${i + 1} no es válido`);
  if (!KINDS.includes(r.kind)) bad(`Requisito ${i + 1}: tipo no válido`);
  const ids = r.resourceIds === undefined ? [] : r.resourceIds;
  if (!Array.isArray(ids) || ids.length > 100) bad(`Requisito ${i + 1}: recursos no válidos`);
  return clean({
    kind: r.kind,
    count: int(r.count, `Requisito ${i + 1}: cantidad`, { min: 1, max: 10 }) ?? 1,
    resourceIds: ids.map((id) => objectId(id, `Requisito ${i + 1}: recurso`)),
    optional: bool(r.optional, 'optional') ?? false,
    customerCanChoose: bool(r.customerCanChoose, 'customerCanChoose') ?? false,
    matchPartySize: bool(r.matchPartySize, 'matchPartySize') ?? false,
  });
}

function serviceInput(body, { partial = false } = {}) {
  const out = clean({
    name: str(body.name, 'El nombre', { max: 120, required: !partial }),
    category: str(body.category, 'La categoría', { max: 60 }),
    description: str(body.description, 'La descripción', { max: 1000 }),
    durationMin: int(body.durationMin, 'La duración', { min: 5, max: 1440, step5: true }),
    bufferBeforeMin: int(body.bufferBeforeMin, 'El margen previo', { min: 0, max: 240, step5: true }),
    bufferAfterMin: int(body.bufferAfterMin, 'El margen posterior', { min: 0, max: 240, step5: true }),
    slotIntervalMin: int(body.slotIntervalMin, 'El intervalo', { min: 5, max: 240, step5: true }),
    poolCapacity: body.poolCapacity === null ? null : int(body.poolCapacity, 'El aforo', { min: 1, max: 5000 }),
    staffCommissionPercent: body.staffCommissionPercent === null ? null : int(body.staffCommissionPercent, 'La comisión', { min: 0, max: 100 }),
    active: bool(body.active, 'active'),
    sortOrder: int(body.sortOrder, 'El orden', { min: 0, max: 10000 }),
  });
  if (!partial && out.durationMin === undefined) bad('La duración es obligatoria');
  if (has(body, 'bookingMode')) {
    if (!['slot', 'quote'].includes(body.bookingMode)) bad('bookingMode no es válido');
    out.bookingMode = body.bookingMode;
  }
  if (has(body, 'capacityMode')) {
    if (!['resource', 'pool'].includes(body.capacityMode)) bad('capacityMode no es válido');
    out.capacityMode = body.capacityMode;
  }
  if (has(body, 'partySize')) {
    const p = body.partySize || {};
    const min = int(p.min, 'Personas mínimas', { min: 1, max: 500 }) ?? 1;
    const max = int(p.max, 'Personas máximas', { min: 1, max: 500 }) ?? min;
    if (max < min) bad('Personas máximas menor que mínimas');
    out.partySize = { min, max };
  }
  if (has(body, 'requirements')) {
    if (!Array.isArray(body.requirements) || body.requirements.length > 5) bad('Los requisitos no son válidos');
    out.requirements = body.requirements.map(requirementInput);
  }
  if (has(body, 'price')) {
    const p = body.price || {};
    out.price = clean({
      amount: int(p.amount, 'El precio', { min: 0, max: 10_000_000 }) ?? 0,
      currency: p.currency === undefined ? 'eur' : str(p.currency, 'La moneda', { max: 3 }).toLowerCase(),
      from: bool(p.from, 'price.from') ?? false,
      perPerson: bool(p.perPerson, 'price.perPerson') ?? false,
    });
  }
  if (has(body, 'tax')) {
    const t = body.tax || {};
    out.tax = {
      rate: int(t.rate, 'El IVA', { min: 0, max: 100 }) ?? 21,
      exemptReason: t.exemptReason === undefined || t.exemptReason === null ? null : str(t.exemptReason, 'Motivo de exención', { max: 60 }),
    };
  }
  if (has(body, 'onlineBooking')) {
    const o = body.onlineBooking || {};
    out.onlineBooking = {
      enabled: bool(o.enabled, 'onlineBooking.enabled') ?? true,
      minNoticeHours: int(o.minNoticeHours, 'La antelación mínima', { min: 0, max: 24 * 60 }) ?? 0,
      maxDaysAhead: int(o.maxDaysAhead, 'Los días máximos', { min: 1, max: 730 }) ?? 60,
      requireApproval: bool(o.requireApproval, 'onlineBooking.requireApproval') ?? false,
    };
  }
  return out;
}

// Rules checked on the final document (after merging a partial update).
function checkServiceConsistency(s) {
  if ((s.bookingMode || 'slot') === 'slot') {
    if ((s.capacityMode || 'resource') === 'pool') {
      if (!s.poolCapacity) bad('El aforo es obligatorio en modo aforo');
    } else if (!(s.requirements || []).some((r) => !r.optional)) {
      bad('Indica al menos un recurso obligatorio (p. ej. un profesional o una mesa)');
    }
  }
  if (s.partySize && s.poolCapacity && s.partySize.max > s.poolCapacity) bad('El grupo máximo supera el aforo');
}

function windowList(list, name) {
  if (!Array.isArray(list) || list.length > 20) bad(`${name} no es válido`);
  return list.map((w) => {
    if (!w || !TIME_OR_24.test(w.start) || !TIME_OR_24.test(w.end) || toMinutes(w.end) <= toMinutes(w.start)) bad(`${name}: tramo horario no válido`);
    if (!isAligned(toMinutes(w.start)) || !isAligned(toMinutes(w.end))) bad(`${name}: las horas deben ser múltiplo de 5 minutos`);
    return { start: w.start, end: w.end };
  });
}

function scheduleInput(body) {
  const rules = body.rules === undefined ? [] : body.rules;
  if (!Array.isArray(rules) || rules.length > 50) bad('Las reglas no son válidas');
  const cleanRules = rules.map((r, i) => {
    const days = r?.days;
    if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) bad(`Regla ${i + 1}: días no válidos`);
    const [w] = windowList([{ start: r.start, end: r.end }], `Regla ${i + 1}`);
    return { days: [...new Set(days)].sort(), ...w, label: str(r.label, 'La etiqueta', { max: 40 }) || '' };
  });
  const overrides = body.overrides === undefined ? [] : body.overrides;
  if (!Array.isArray(overrides) || overrides.length > 200) bad('Las excepciones no son válidas');
  const cleanOverrides = overrides.map((o, i) => {
    const from = date(o?.from, `Excepción ${i + 1}: desde`);
    const to = o.to === undefined ? from : date(o.to, `Excepción ${i + 1}: hasta`);
    if (to < from) bad(`Excepción ${i + 1}: rango no válido`);
    const closed = bool(o.closed, 'closed') ?? false;
    const out = { from, to, closed, reason: str(o.reason, 'El motivo', { max: 120 }) || '' };
    if (!closed) {
      if (o.windows === undefined) bad(`Excepción ${i + 1}: indica si está cerrado o sus horas`);
      out.windows = windowList(o.windows, `Excepción ${i + 1}`);
    }
    return out;
  });
  return { rules: cleanRules, overrides: cleanOverrides };
}

function guestInput(body, { requireContact }) {
  const name = str(body.guestName, 'El nombre', { max: 100, required: true });
  const phone = str(body.guestPhone, 'El teléfono', { max: 30 }) || '';
  const email = (str(body.guestEmail, 'El email', { max: 200 }) || '').toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('El email no es válido');
  if (requireContact && !phone) bad('El teléfono es obligatorio');
  if (requireContact && !email) bad('El email es obligatorio');
  return { name, phone, email };
}

function bookingInput(body, { online }) {
  const d = date(body.date, 'La fecha');
  if (typeof body.time !== 'string' || !TIME.test(body.time)) bad('La hora no es válida');
  const items = body.items;
  if (!Array.isArray(items) || !items.length || items.length > 5) bad('Indica entre 1 y 5 servicios');
  return {
    date: d,
    time: body.time,
    items: items.map((it, i) => ({
      serviceId: objectId(it?.serviceId, `Servicio ${i + 1}`),
      resourceId: it?.resourceId ? objectId(it.resourceId, `Profesional ${i + 1}`) : null,
    })),
    partySize: int(body.partySize, 'El número de personas', { min: 1, max: 500 }) ?? 1,
    guest: guestInput(body, { requireContact: online }),
    notes: str(body.notes, 'Las notas', { max: 1000 }) || '',
    internalNotes: online ? '' : (str(body.internalNotes, 'Las notas internas', { max: 2000 }) || ''),
  };
}

module.exports = {
  resourceInput, imageDataUrl, serviceInput, checkServiceConsistency, scheduleInput, bookingInput, dateRange, objectId, bad,
};
