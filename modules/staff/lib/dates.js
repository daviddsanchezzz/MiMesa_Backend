const MONTH = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const parts = (iso) => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; };

/** "5 – 11 oct" or "28 sep – 4 oct". */
function fmtRangeEs(from, to) {
  const a = parts(from);
  const b = parts(to);
  if (a.m === b.m) return `${a.d} – ${b.d} ${MONTH[b.m - 1]}`;
  return `${a.d} ${MONTH[a.m - 1]} – ${b.d} ${MONTH[b.m - 1]}`;
}

const fmtDayEs = (iso) => { const p = parts(iso); return `${p.d} ${MONTH[p.m - 1]}`; };

module.exports = { fmtRangeEs, fmtDayEs };
