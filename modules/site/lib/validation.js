/** Input checks for the site profile (how to book, social links). */
class SiteError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const bad = (message) => { throw new SiteError(message); };

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

/** Google reviews: rating (0–5, one decimal) and how many; both or none. Accepts "4,6" as well as 4.6. */
function reviews(input) {
  if (input === undefined) return undefined;
  const r = input && typeof input === 'object' ? input : {};
  const blank = (x) => x === undefined || x === null || String(x).trim() === '';
  const link = url(r.url, 'El enlace de las reseñas');
  if (blank(r.rating) && blank(r.count)) return { rating: null, count: null, url: '' };
  if (blank(r.rating) || blank(r.count)) bad('Pon la valoración y cuántas reseñas tienes (o deja las dos vacías)');
  const rating = Number(String(r.rating).replace(',', '.'));
  const rawCount = String(r.count).trim().replace(/\s/g, '');
  // "1.234" is a thousand separator, "2.5" is not a whole number
  const count = Number(/^\d{1,3}(\.\d{3})+$/.test(rawCount) ? rawCount.replace(/\./g, '') : rawCount.replace(',', '.'));
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) bad('La valoración va de 0 a 5');
  if (!Number.isInteger(count) || count < 0 || count > 10_000_000) bad('El número de reseñas no es válido');
  return { rating: Math.round(rating * 10) / 10, count, url: link };
}

/** What the editor sends: how to book and the social links. Only what is present is validated and returned. */
function profile(body = {}) {
  const out = {};
  const set = (key, value) => { if (value !== undefined) out[key] = value; };
  set('reservations', reservations(body.reservations));
  set('social', social(body.social));
  set('reviews', reviews(body.reviews));
  return out;
}

module.exports = { SiteError, social, reservations, reviews, profile };
