/**
 * Importing the articles of a POS (TPV) into the menu. The screen turns whatever file the TPV
 * exports into rows { externalId, category, name, price }; nothing here knows about a TPV.
 * Pure: the controller loads what exists and applies the plan.
 *
 * What the TPV controls is the price (and that a dish exists). Names, descriptions, photos,
 * allergens and translations are the restaurant's own and an import never overwrites them.
 */
const MAX_ROWS = 1500;

const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function normalizeRows(input) {
  if (!Array.isArray(input) || !input.length) return { rows: [], errors: [{ line: 0, message: 'No hay platos que importar' }] };
  if (input.length > MAX_ROWS) return { rows: [], errors: [{ line: 0, message: `Demasiadas filas (máximo ${MAX_ROWS})` }] };
  const rows = [];
  const errors = [];
  const seen = new Set();
  input.forEach((raw, i) => {
    const line = i + 1;
    const name = String(raw?.name ?? '').trim().slice(0, 120);
    const category = String(raw?.category ?? '').trim().slice(0, 80) || 'Sin categoría';
    const externalId = String(raw?.externalId ?? '').trim().slice(0, 100);
    if (!name) { errors.push({ line, message: 'Falta el nombre' }); return; }
    let price = null;
    if (raw?.price !== undefined && raw?.price !== null && raw?.price !== '') {
      price = Number(raw.price);
      if (!Number.isFinite(price) || price < 0 || price > 10_000) { errors.push({ line, message: `${name}: precio no válido` }); return; }
      price = Math.round(price * 100) / 100;
    }
    const key = externalId ? `id:${externalId}` : `n:${strip(category)}|${strip(name)}`;
    if (seen.has(key)) { errors.push({ line, message: `${name}: repetido en el archivo` }); return; }
    seen.add(key);
    const description = String(raw?.description ?? '').trim().slice(0, 500);
    rows.push({ externalId, category, name, price, description });
  });
  return { rows, errors };
}

const namesOf = (doc) => Object.values(doc?.name || {}).map(strip).filter(Boolean);

/**
 * Per row: new · same · price (the TPV changed it) · link (a dish already in the menu by hand now
 * follows the TPV price) · plus the TPV dishes that no longer appear (`missing`).
 *  existing: { categories, items, language } — lean docs; `language` is the main one.
 *  source: 'tpv' (prices come from the till and get locked here) or 'manual' (a menu copied from
 *          somewhere else: prices stay editable, nothing is linked and nothing is "missing").
 */
function planImport(rows, { categories, items, language, source = 'tpv' }) {
  const catByName = new Map();
  for (const c of categories) for (const n of namesOf(c)) if (!catByName.has(n)) catByName.set(n, c);
  const byExternal = new Map(items.filter((i) => i.externalId).map((i) => [i.externalId, i]));
  const matched = new Set();

  const plan = rows.map((r) => {
    const cat = catByName.get(strip(r.category)) || null;
    let item = r.externalId ? byExternal.get(r.externalId) : null;
    if (!item && cat) {
      item = items.find((i) => String(i.categoryId) === String(cat._id) && !matched.has(String(i._id))
        && (!i.externalId || !r.externalId) && strip(i.name?.[language]) === strip(r.name)) || null;
    }
    if (item) matched.add(String(item._id));
    const base = { ...r, categoryNew: !cat, itemId: item ? String(item._id) : null, previous: item?.price ?? null, restore: !!item?.retired };
    if (!item) return { ...base, status: 'new' };
    if (source === 'tpv' && item.priceSource !== 'tpv') return { ...base, status: 'link' };
    return { ...base, status: item.price === r.price ? 'same' : 'price' };
  });

  const missing = source !== 'tpv' ? [] : items.filter((i) => i.priceSource === 'tpv' && !i.retired && !matched.has(String(i._id)))
    .map((i) => ({ itemId: String(i._id), name: i.name?.[language] || Object.values(i.name || {})[0] || '' }));
  return { plan, missing };
}

module.exports = { normalizeRows, planImport, strip, MAX_ROWS };
