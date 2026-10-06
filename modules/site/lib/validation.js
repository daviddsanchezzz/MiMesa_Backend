/** Input checks for the restaurant's site profile. */
class SiteError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const bad = (message) => { throw new SiteError(message); };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_OR_24 = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGES = 3;
const MAX_CLOSURES = 60;

const validDate = (x) => typeof x === 'string' && DATE.test(x) && !Number.isNaN(Date.parse(`${x}T12:00:00Z`));
const text = (x, max, label) => {
  if (x === undefined || x === null) return '';
  if (typeof x !== 'string') bad(`${label} no es válido`);
  const t = x.trim();
  if (t.length > max) bad(`${label} es demasiado largo`);
  return t;
};
const url = (x, label) => {
  const t = text(x, 400, label);
  if (t && !/^https?:\/\/[^\s]+$/i.test(t)) bad(`${label} debe empezar por http:// o https://`);
  return t;
};

/**
 * 7 days (0 = Sunday … 6). A range is { open, close }; close may be before open (a dinner that ends after
 * midnight) or "24:00". Days not sent are closed. Returns the 7 days sorted, ranges ordered by opening.
 */
function openingHours(input) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) bad('El horario no es válido');
  const byDay = new Map();
  for (const d of input) {
    const day = Number(d?.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) bad('Día no válido');
    if (byDay.has(day)) bad('Un día aparece repetido');
    const ranges = Array.isArray(d?.ranges) ? d.ranges : bad('El horario no es válido');
    if (ranges.length > MAX_RANGES) bad(`Como máximo ${MAX_RANGES} franjas por día`);
    byDay.set(day, ranges.map((r) => {
      if (!TIME.test(r?.open || '') || !TIME_OR_24.test(r?.close || '')) bad('Las horas deben ser HH:MM');
      if (r.open === r.close) bad('La hora de apertura y la de cierre no pueden ser la misma');
      return { open: r.open, close: r.close };
    }).sort((a, b) => a.open.localeCompare(b.open)));
  }
  return [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, ranges: byDay.get(day) || [] }));
}

function closures(input) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > MAX_CLOSURES) bad(`Como máximo ${MAX_CLOSURES} cierres`);
  return input.map((c) => {
    if (!validDate(c?.from) || !validDate(c?.to)) bad('La fecha de un cierre no es válida');
    if (c.to < c.from) bad('Un cierre acaba antes de empezar');
    return { from: c.from, to: c.to, reason: text(c.reason, 200, 'El motivo') };
  }).sort((a, b) => a.from.localeCompare(b.from));
}

const HANDLE = /^@?[A-Za-z0-9._]{1,60}$/;
function social(input) {
  if (input === undefined) return undefined;
  const s = input && typeof input === 'object' ? input : {};
  const handleOrUrl = (x, label) => {
    const t = text(x, 200, label);
    if (t && !HANDLE.test(t) && !/^https?:\/\/[^\s]+$/i.test(t)) bad(`${label}: pon el usuario (@usuario) o el enlace`);
    return t;
  };
  const phone = text(s.whatsapp, 30, 'WhatsApp');
  if (phone && !/^\+?[\d\s()-]{6,30}$/.test(phone)) bad('WhatsApp: pon un teléfono');
  return {
    instagram: handleOrUrl(s.instagram, 'Instagram'),
    tiktok: handleOrUrl(s.tiktok, 'TikTok'),
    facebook: url(s.facebook, 'El enlace de Facebook'),
    youtube: url(s.youtube, 'El enlace de YouTube'),
    whatsapp: phone,
  };
}

function reservations(input) {
  if (input === undefined) return undefined;
  const mode = input?.mode;
  if (!['none', 'vetra', 'link', 'phone'].includes(mode)) bad('Elige cómo reservar');
  const link = url(input.url, 'El enlace de reservas');
  if (mode === 'link' && !link) bad('Pon el enlace de reservas');
  return { mode, url: mode === 'link' ? link : '' };
}

function email(x) {
  const t = text(x, 200, 'El email').toLowerCase();
  if (t && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) bad('El email no es válido');
  return t;
}

/** The whole profile as the editor sends it; only what is present is validated and returned. */
function profile(body = {}) {
  const out = {};
  const set = (key, value) => { if (value !== undefined) out[key] = value; };
  set('openingHours', openingHours(body.openingHours));
  set('closures', closures(body.closures));
  set('reservations', reservations(body.reservations));
  set('social', social(body.social));
  if (body.contactEmail !== undefined) out.contactEmail = email(body.contactEmail);
  if (body.mapsUrl !== undefined) out.mapsUrl = url(body.mapsUrl, 'El enlace del mapa');
  return out;
}

module.exports = { SiteError, openingHours, closures, social, reservations, profile, validDate };
