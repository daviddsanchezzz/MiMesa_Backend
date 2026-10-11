/**
 * Input checks for the menu. Texts per language are { es: '…', en: '…' }: only the business's
 * languages are kept and the main one is required for names.
 */
const { ALLERGENS, TAGS, LANGUAGE_RE, MAX_LANGUAGES } = require('./constants');

class MenuError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const bad = (message) => { throw new MenuError(message); };

function languages(input) {
  if (!Array.isArray(input) || !input.length) bad('Elige al menos un idioma');
  const out = [...new Set(input.map((x) => String(x).trim().toLowerCase()))];
  if (out.length > MAX_LANGUAGES) bad(`Como máximo ${MAX_LANGUAGES} idiomas`);
  if (out.some((x) => !LANGUAGE_RE.test(x))) bad('Idioma no válido');
  return out;
}

/** { es, en } → only the languages in use, trimmed; `required` = the main language must be there. */
function texts(input, langs, { label, max, required = false }) {
  const out = {};
  for (const lang of langs) {
    const v = input && typeof input === 'object' ? input[lang] : undefined;
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') bad(`${label} no es válido`);
    const t = v.trim();
    if (t.length > max) bad(`${label} es demasiado largo (máximo ${max} caracteres)`);
    if (t) out[lang] = t;
  }
  if (required && !out[langs[0]]) bad(`${label} es obligatorio`);
  return out;
}

function price(value) {
  if (value === null || value === '' || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) bad('El precio no es válido');
  return Math.round(n * 100) / 100;
}

function pick(list, allowed, label) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) bad(`${label} no es válido`);
  const out = [...new Set(list.map(String))];
  if (out.some((x) => !allowed.includes(x))) bad(`${label} no es válido`);
  return out;
}

const allergens = (list) => pick(list, ALLERGENS, 'Los alérgenos');
const tags = (list) => pick(list, TAGS, 'Las etiquetas');

const MAX_EXTRAS = 12;

/** Extras of a dish or a category: up to 12, each with a name in the main language, an optional price and allergens. */
function extras(list, langs) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > MAX_EXTRAS) bad(`Como máximo ${MAX_EXTRAS} extras`);
  return list.map((x, i) => ({
    name: texts(x?.name, langs, { label: `El nombre del extra ${i + 1}`, max: 80, required: true }),
    price: price(x?.price),
    allergens: allergens(x?.allergens) || [],
  }));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The menú del día: price, validity and up to 6 courses of up to 20 options each. */
function daily(body, langs) {
  const b = body || {};
  const date = (x, label) => {
    if (x === undefined || x === null || x === '') return '';
    if (typeof x !== 'string' || !DATE_RE.test(x) || Number.isNaN(Date.parse(`${x}T12:00:00Z`))) bad(`${label} no es válida`);
    return x;
  };
  const from = date(b.from, 'La fecha de inicio');
  const to = date(b.to, 'La fecha de fin');
  if (from && to && to < from) bad('La fecha de fin es anterior a la de inicio');
  const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number))] : [];
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) bad('Los días no son válidos');
  if (!Array.isArray(b.courses) || b.courses.length > 6) bad('Como máximo 6 apartados');
  const courses = b.courses.map((c, i) => {
    if (!Array.isArray(c?.options) || c.options.length > 20) bad(`Apartado ${i + 1}: como máximo 20 platos`);
    return {
      name: texts(c.name, langs, { label: `El nombre del apartado ${i + 1}`, max: 60, required: true }),
      options: c.options.map((o, j) => ({
        name: texts(o?.name, langs, { label: `El plato ${j + 1} del apartado ${i + 1}`, max: 120, required: true }),
        allergens: allergens(o?.allergens) || [],
      })),
    };
  });
  return {
    active: b.active === true,
    title: texts(b.title, langs, { label: 'El título', max: 80 }),
    includes: texts(b.includes, langs, { label: 'Lo que incluye', max: 200 }),
    price: price(b.price),
    days: days.sort(),
    from,
    to,
    courses,
  };
}

module.exports = { extras, daily, MenuError, languages, texts, price, allergens, tags, bad };
