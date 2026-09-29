/**
 * Resolves a project module by trying its current location first and then
 * the location it will have after the core/modules refactor. Lets the same
 * tests run before and after files are moved.
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function load(...candidates) {
  for (const rel of candidates) {
    try {
      return require(require.resolve(path.join(ROOT, rel)));
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND' || !String(err.message).includes(path.join(ROOT, rel))) throw err;
    }
  }
  throw new Error(`Module not found in any of: ${candidates.join(', ')}`);
}

const lib = (name) => load(`lib/${name}`, `core/lib/${name}`);

module.exports = { load, lib, ROOT };
