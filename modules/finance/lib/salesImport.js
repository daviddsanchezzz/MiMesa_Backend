/**
 * Importing the daily sales of a restaurant from its POS (TPV): the closing report, once a day.
 * Whatever the file looks like, the screen turns it into rows of this single shape and sends them
 * here; nothing in this file knows about a particular TPV. Pure: the controller does the I/O.
 * Money in euros (like the rest of Finanzas).
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 400;
const MAX_MONEY = 1_000_000;
const MONEY_FIELDS = ['total', 'cash', 'card', 'bizum', 'other', 'tips'];
const COUNT_FIELDS = ['tickets', 'covers'];

const round2 = (n) => Math.round(n * 100) / 100;

function money(value, label, errors) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) { errors.push(`${label} no es válido`); return null; }
  return round2(n);
}

function count(value, label, errors) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100_000) { errors.push(`${label} no es válido`); return null; }
  return n;
}

const add = (a, b) => (a === null ? b : b === null ? a : a + b);

/**
 * Validates the rows and merges those of the same day (a report with one line per payment method
 * adds up to one day). `total` falls back to the sum of the methods when the file has no total.
 * Returns { rows, errors: [{ line, message }] }; a row with an error is left out.
 */
function normalizeRows(input) {
  if (!Array.isArray(input) || input.length === 0) return { rows: [], errors: [{ line: 0, message: 'No hay filas que importar' }] };
  if (input.length > MAX_ROWS) return { rows: [], errors: [{ line: 0, message: `Demasiadas filas (máximo ${MAX_ROWS})` }] };
  const byDate = new Map();
  const errors = [];
  input.forEach((raw, i) => {
    const line = i + 1;
    const problems = [];
    const date = String(raw?.date || '');
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) problems.push('La fecha no es válida');
    const row = { date };
    for (const f of MONEY_FIELDS) row[f] = money(raw?.[f], f === 'total' ? 'El total' : `El campo ${f}`, problems);
    for (const f of COUNT_FIELDS) row[f] = count(raw?.[f], `El campo ${f}`, problems);
    if (!problems.length && row.total === null) {
      const parts = ['cash', 'card', 'bizum', 'other'].map((f) => row[f]).filter((x) => x !== null);
      if (!parts.length) problems.push('Falta el total');
      else row.total = round2(parts.reduce((s, x) => s + x, 0));
    }
    if (problems.length) { errors.push({ line, message: problems[0] }); return; }
    const prev = byDate.get(date);
    if (!prev) { byDate.set(date, row); return; }
    for (const f of [...MONEY_FIELDS, ...COUNT_FIELDS]) prev[f] = add(prev[f], row[f]);
  });
  const rows = [...byDate.values()].map((r) => {
    for (const f of MONEY_FIELDS) if (r[f] !== null) r[f] = round2(r[f]);
    return r;
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { rows, errors };
}

/**
 * What applying the rows would do, day by day.
 *  existing: Map date → saved DailyRevenue ({ actualRevenue, source })
 *  average: usual daily revenue of the business (to flag figures far from it), 0 if unknown
 *  overwrite: 'all' replaces figures already there; 'empty' only fills the days without one
 */
function planImport(rows, existing, { average = 0, overwrite = 'all' } = {}) {
  return rows.map((r) => {
    const saved = existing.get(r.date);
    const previous = saved?.actualRevenue ?? null;
    const warnings = [];
    if (average > 0 && r.total > average * 5) warnings.push('Es mucho más de lo habitual');
    if (r.total === 0) warnings.push('Total a cero');
    if (r.cash !== null && r.card !== null && r.total > 0) {
      const parts = ['cash', 'card', 'bizum', 'other'].reduce((s, f) => s + (r[f] || 0), 0);
      if (Math.abs(parts - r.total) > Math.max(1, r.total * 0.02)) warnings.push('Los métodos de pago no suman el total');
    }
    let status;
    if (previous === null) status = 'new';
    else if (previous === r.total) status = 'same';
    else status = overwrite === 'empty' ? 'skip' : 'update';
    return { ...r, status, previous, manualPrevious: saved?.source === 'manual' && previous !== null, warnings };
  });
}

module.exports = { normalizeRows, planImport, MAX_ROWS };
