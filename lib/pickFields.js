function pickFields(source, allowed) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  return out;
}

module.exports = { pickFields };
