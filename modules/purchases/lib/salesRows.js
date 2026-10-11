/**
 * The rows of "sales by dish" of a till, validated. Whatever the file looked like, the screen sends rows of
 * { date, name, externalId?, quantity, amount? }. Pure.
 */
const { lineKey } = require('./ingredientParse');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 20000;
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** → { rows: [{ date, key, name, externalId, quantity, amount }], skipped, errors } — the same dish on the same day adds up. */
function normalizeSales(input) {
  if (!Array.isArray(input) || !input.length) return { rows: [], skipped: 0, errors: [{ line: 0, message: 'No hay filas que importar' }] };
  if (input.length > MAX_ROWS) return { rows: [], skipped: 0, errors: [{ line: 0, message: `Demasiadas filas (máximo ${MAX_ROWS})` }] };
  const map = new Map();
  const errors = [];
  let skipped = 0;
  input.forEach((raw, i) => {
    const date = String(raw?.date || '');
    const name = String(raw?.name || '').trim().slice(0, 200);
    const externalId = String(raw?.externalId || '').trim().slice(0, 60);
    const quantity = Number(raw?.quantity);
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) { errors.push({ line: i + 1, message: 'La fecha no es válida' }); return; }
    if (!name && !externalId) { errors.push({ line: i + 1, message: 'Falta el plato' }); return; }
    if (!Number.isFinite(quantity)) { errors.push({ line: i + 1, message: 'Las unidades no son válidas' }); return; }
    if (quantity <= 0) { skipped += 1; return; }   // returns and zero lines do not consume
    const amountRaw = raw?.amount;
    const amount = amountRaw === undefined || amountRaw === null || amountRaw === '' || !Number.isFinite(Number(amountRaw)) ? null : round(Number(amountRaw));
    const key = externalId ? `id:${externalId}` : `n:${lineKey(name)}`;
    const id = `${date}|${key}`;
    const prev = map.get(id);
    if (!prev) { map.set(id, { date, key, name, externalId, quantity: round(quantity, 3), amount }); return; }
    prev.quantity = round(prev.quantity + quantity, 3);
    if (amount !== null) prev.amount = round((prev.amount || 0) + amount);
    if (!prev.name && name) prev.name = name;
  });
  return { rows: [...map.values()], skipped, errors };
}

module.exports = { normalizeSales };
