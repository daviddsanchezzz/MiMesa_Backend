/**
 * Turning what an invoice says ("LIMON BANDEJA 1KG", "Aceite oliva 5L", "Cerveza 24x33cl") into an ingredient
 * with a unit and how much of it each purchased unit holds. Pure: a suggestion the restaurant can correct.
 */
const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The same line always gives the same key, whatever the case, accents, spaces or punctuation. */
const lineKey = (description) => strip(description).replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);

const UNITS = { kg: ['kg', 1], g: ['kg', 0.001], l: ['l', 1], lt: ['l', 1], cl: ['l', 0.01], ml: ['l', 0.001] };
const NUM = '(\\d+(?:[.,]\\d+)?)';
const SIZE = new RegExp(`${NUM}\\s*(kg|g|lt|l|cl|ml)\\b`, 'i');
const MULTI = new RegExp(`(\\d+)\\s*[x×]\\s*${NUM}\\s*(kg|g|lt|l|cl|ml)\\b`, 'i');
const COUNT = /(?:\bx\s*(\d+)\b|\b(\d+)\s*(?:uds?|unid(?:ades)?|u)\b)/i;
const NOISE = /\b(caja|cajas|bandeja|bolsa|saco|garrafa|botella|bot|pack|lata|envase|granel|ud|uds|unidad|unidades|kg|l|g)\b/gi;

const num = (s) => Number(String(s).replace(',', '.'));

/** { name, unit: 'kg'|'l'|'ud', content } where content is how many `unit` one purchased unit holds. */
function suggestFromDescription(description) {
  const text = String(description ?? '').trim();
  let unit = 'kg';   // a line without a size is most often billed by weight (fruit, meat, fish)
  let content = 1;
  const multi = text.match(MULTI);
  const size = text.match(SIZE);
  if (multi) {
    const [base, factor] = UNITS[multi[3].toLowerCase()];
    unit = base;
    content = Math.round(Number(multi[1]) * num(multi[2]) * factor * 1000) / 1000;
  } else if (size) {
    const [base, factor] = UNITS[size[2].toLowerCase()];
    unit = base;
    content = Math.round(num(size[1]) * factor * 1000) / 1000;
  } else {
    const count = text.match(COUNT);
    if (count) { unit = 'ud'; content = Number(count[1] || count[2]) || 1; }
  }
  if (!(content > 0)) content = 1;
  const cleaned = text.replace(MULTI, ' ').replace(SIZE, ' ').replace(COUNT, ' ').replace(NOISE, ' ')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const name = cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : text;
  return { name: name.slice(0, 80), unit, content };
}

module.exports = { lineKey, suggestFromDescription, strip };
