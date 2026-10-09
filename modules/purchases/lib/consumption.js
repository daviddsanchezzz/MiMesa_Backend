/**
 * What the kitchen should have used, against what came in. Pure: the controller does the I/O.
 *
 *   theoretical use of an ingredient = Σ units sold of each dish × what its recipe puts in a serving (plus waste of preparing)
 *   explained = theoretical + thrown away (waste entries)
 *   with two stock counts:  real use = opening + bought − closing;  difference = real use − explained
 *   without counts:         difference = bought − explained   (assumes the shelves end as they began)
 * A positive difference is stock that is missing: lost, given away, over-portioned or not recorded.
 */
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** { use: Map(ingredientId → qty), units, covered, uncovered: [{ name, units }] } */
function theoreticalUse(sales, recipes) {
  const byItem = new Map(recipes.map((r) => [String(r.itemId), r]));
  const use = new Map();
  let units = 0;
  let covered = 0;
  const uncovered = new Map();
  for (const sale of sales) {
    const q = Number(sale.quantity) || 0;
    if (q <= 0) continue;
    units += q;
    const recipe = sale.itemId ? byItem.get(String(sale.itemId)) : null;
    if (!recipe || !recipe.lines?.length) {
      const k = sale.key || sale.name;
      const prev = uncovered.get(k) || { name: sale.name || k, units: 0, matched: Boolean(sale.itemId) };
      prev.units += q;
      uncovered.set(k, prev);
      continue;
    }
    covered += q;
    for (const line of recipe.lines) {
      const waste = Math.min(0.9, Math.max(0, (Number(line.wastePct) || 0) / 100));
      const id = String(line.ingredientId);
      use.set(id, (use.get(id) || 0) + q * (Number(line.quantity) || 0) / (1 - waste));
    }
  }
  return { use, units: round(units, 2), covered: round(covered, 2), uncovered: [...uncovered.values()].sort((a, b) => b.units - a.units) };
}

/**
 * One row per ingredient that has any movement.
 *   theoretical, purchased, wasted: Map(ingredientId → qty)
 *   opening, closing: Map(ingredientId → qty) or null when there is no count
 *   ingredients: Map(ingredientId → { name, unit, lastPrice })
 */
function reconcile({ theoretical, purchased, wasted, opening = null, closing = null, ingredients }) {
  const ids = new Set([...theoretical.keys(), ...purchased.keys(), ...wasted.keys()]);
  const rows = [];
  for (const id of ids) {
    const ing = ingredients.get(id);
    if (!ing) continue;
    const t = theoretical.get(id) || 0;
    const p = purchased.get(id) || 0;
    const w = wasted.get(id) || 0;
    const explained = t + w;
    const o = opening?.get(id);
    const c = closing?.get(id);
    const counted = o !== undefined && c !== undefined;
    const real = counted ? o + p - c : p;
    const difference = real - explained;
    rows.push({
      ingredientId: id, name: ing.name, unit: ing.unit,
      theoretical: round(t), purchased: round(p), wasted: round(w),
      opening: o === undefined ? null : round(o), closing: c === undefined ? null : round(c),
      counted,
      difference: round(difference),
      differencePct: explained > 0 ? round((difference / explained) * 100, 1) : null,
      value: ing.lastPrice == null ? null : round(difference * ing.lastPrice, 2),
    });
  }
  return rows.sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0) || a.name.localeCompare(b.name, 'es'));
}

module.exports = { theoreticalUse, reconcile };
