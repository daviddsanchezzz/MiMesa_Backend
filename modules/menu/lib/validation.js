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

module.exports = { MenuError, languages, texts, price, allergens, tags, bad };
