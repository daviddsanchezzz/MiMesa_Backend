/**
 * Public address of a business: https://vetrareserve.com/{slug}.
 *
 * A slug is 3-50 characters of lowercase letters, digits and single hyphens,
 * generated from the business name and editable by the business. Previous
 * slugs are kept in slugHistory so old links keep working (and are never
 * handed to another business).
 */

const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,48}[a-z0-9]$/;
const MAX_LEN = 50;
const MAX_HISTORY = 10;

// Paths the website or the app use, or may use, at the top level.
const RESERVED = new Set([
  'about', 'acceso', 'account', 'admin', 'agenda', 'api', 'app', 'apps', 'assets', 'ayuda', 'baja', 'blog',
  'caja', 'cancel', 'cancelar', 'cita', 'citas', 'clientes', 'configuracion', 'contact', 'contacto', 'cookies',
  'dashboard', 'demo', 'dev', 'docs', 'email', 'empresa', 'equipo', 'faq', 'favicon', 'finanzas', 'fonts',
  'help', 'home', 'img', 'images', 'index', 'inicio', 'invite', 'legal', 'llms', 'login', 'logout', 'mail',
  'manifest', 'mimesa', 'negocios', 'nosotros', 'onboarding', 'panel', 'precios', 'pricing', 'privacidad',
  'privacy', 'profile', 'public', 'publico', 'register', 'reserva', 'reservar', 'reservas', 'reservations',
  'reserve', 'restaurantes', 'robots', 'settings', 'signup', 'sitemap', 'soporte', 'static', 'status',
  'support', 'terminos', 'terms', 'test', 'unsubscribe', 'vetra', 'vetrareserve', 'www',
  // Planned landing pages
  'software-reservas-restaurantes', 'programa-citas-peluqueria', 'software-centro-estetica', 'agenda-fisioterapia',
]);

class SlugError extends Error {
  constructor(message, status = 400, code = 'BAD_SLUG') { super(message); this.status = status; this.code = code; }
}

/** "Estética Són & Co." → "estetica-son-y-co" */
function slugify(text) {
  let s = String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > MAX_LEN) {
    s = s.slice(0, MAX_LEN);
    const cut = s.lastIndexOf('-');
    if (cut >= 20) s = s.slice(0, cut);
    s = s.replace(/-+$/g, '');
  }
  if (s.length < 3) s = s ? `${s}-reservas` : 'mi-negocio';
  return s;
}

function isReserved(slug) {
  return RESERVED.has(slug);
}

/** Normalizes what the user typed and checks the format. Throws SlugError. */
function normalizeSlugInput(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new SlugError('Usa entre 3 y 50 letras minúsculas, números o guiones (sin tildes, espacios ni guiones al principio o al final).');
  }
  if (isReserved(slug)) throw new SlugError('Esa dirección está reservada. Prueba con otra.', 400, 'SLUG_RESERVED');
  return slug;
}

/** Is this slug (or an old slug) used by a business other than excludeId? */
async function slugTaken(Business, slug, excludeId = null) {
  const q = { $or: [{ slug }, { slugHistory: slug }] };
  if (excludeId) q._id = { $ne: excludeId };
  return Boolean(await Business.exists(q));
}

/** First free slug from a name: name, name-2, name-3… */
async function uniqueSlugFor(Business, name, excludeId = null) {
  const base = slugify(name);
  for (let n = 1; n < 500; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = `${base.slice(0, MAX_LEN - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!isReserved(candidate) && !(await slugTaken(Business, candidate, excludeId))) return candidate;
  }
  return `${base.slice(0, 40)}-${Date.now().toString(36)}`;
}

/**
 * Changes a business's slug. The old one moves to slugHistory so its links
 * keep working. Returns the new slug. Throws SlugError.
 */
async function changeBusinessSlug(Business, businessId, value) {
  const slug = normalizeSlugInput(value);
  const current = await Business.findById(businessId).select('slug slugHistory').lean();
  if (!current) throw new SlugError('Negocio no encontrado', 404, 'NOT_FOUND');
  if (current.slug === slug) return slug;
  if (await slugTaken(Business, slug, businessId)) {
    throw new SlugError('Esa dirección ya la usa otro negocio. Prueba con otra.', 409, 'SLUG_TAKEN');
  }
  const history = [current.slug, ...(current.slugHistory || [])]
    .filter((s) => s && s !== slug)
    .filter((s, i, all) => all.indexOf(s) === i)
    .slice(0, MAX_HISTORY);
  await Business.updateOne({ _id: businessId }, { $set: { slug, slugHistory: history } });
  return slug;
}

/** Business for a public address: current slug first, then an old one. */
async function findBusinessBySlug(Business, value, select = '_id slug name businessType') {
  const slug = String(value || '').trim().toLowerCase();
  if (!slug || slug.length > 60) return null;
  return (await Business.findOne({ slug }).select(select).lean())
    || (await Business.findOne({ slugHistory: slug }).select(select).lean());
}

module.exports = {
  SLUG_RE, RESERVED, SlugError, slugify, isReserved, normalizeSlugInput,
  slugTaken, uniqueSlugFor, changeBusinessSlug, findBusinessBySlug,
};
