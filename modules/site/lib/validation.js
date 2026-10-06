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

/** What the editor sends: how to book and the social links. Only what is present is validated and returned. */
function profile(body = {}) {
  const out = {};
  const set = (key, value) => { if (value !== undefined) out[key] = value; };
  set('reservations', reservations(body.reservations));
  set('social', social(body.social));
  return out;
}

module.exports = { SiteError, social, reservations, profile };
