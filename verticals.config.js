/**
 * Which verticals (sector-specific parts) this deployment runs.
 * Core loads each one's extension file (verticals/<name>/business.js) from
 * here, so core itself never names a sector.
 */
module.exports = {
  verticals: ['restaurant'],
};
