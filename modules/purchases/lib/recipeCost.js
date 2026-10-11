/**
 * What a dish costs and earns, from its recipe and today's ingredient prices. Pure.
 *
 *   recipe       { lines: [{ ingredientId, quantity, wastePct }], otherCost }
 *   ingredients  Map(String(id) → { name, unit, lastPrice, prevPrice })
 *   settings     { vatPct, targetMarginPct }
 */
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** What one line costs: the price of the quantity you need plus what is lost preparing it. */
function lineCost(line, ing, which = 'now') {
  const price = which === 'before' ? (ing?.prevPrice ?? ing?.lastPrice) : ing?.lastPrice;
  if (price === null || price === undefined) return null;
  const waste = Math.min(0.9, Math.max(0, (Number(line.wastePct) || 0) / 100));
  return (Number(line.quantity) || 0) / (1 - waste) * price;
}

function costOf(recipe, ingredients) {
  let cost = Number(recipe?.otherCost) || 0;
  let before = cost;
  let missing = 0;
  const lines = (recipe?.lines || []).map((line) => {
    const ing = ingredients.get(String(line.ingredientId));
    const now = ing ? lineCost(line, ing) : null;
    const prev = ing ? lineCost(line, ing, 'before') : null;
    if (now === null) missing += 1; else { cost += now; before += prev ?? now; }
    return { ingredientId: String(line.ingredientId), quantity: line.quantity, wastePct: line.wastePct || 0, cost: now === null ? null : round(now, 4) };
  });
  return { cost: round(cost, 4), before: round(before, 4), missing, lines };
}

/** Price without VAT, profit and margin of a dish; margin null when there is no price or no cost. */
function marginOf(price, cost, vatPct) {
  if (price === null || price === undefined || !(price > 0)) return { net: null, profit: null, marginPct: null };
  const net = price / (1 + (Number(vatPct) || 0) / 100);
  const profit = net - cost;
  return { net: round(net, 4), profit: round(profit, 4), marginPct: net > 0 ? round((profit / net) * 100, 1) : null };
}

/** The price (VAT included) that reaches the target margin, rounded up to 10 cents. */
function suggestedPrice(cost, { targetMarginPct = 70, vatPct = 10 } = {}) {
  if (!(cost > 0)) return null;
  const net = cost / (1 - targetMarginPct / 100);
  return Math.ceil(net * (1 + vatPct / 100) * 10 - 1e-9) / 10;
}

module.exports = { lineCost, costOf, marginOf, suggestedPrice };
