/**
 * The Business document stored in MongoDB must keep exactly the same fields
 * (names, types and defaults) whatever file each field is declared in.
 * Regenerate intentionally with: UPDATE_SNAPSHOT=1 npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('../helpers/load');

const SNAPSHOT = path.join(__dirname, '..', '__snapshots__', 'businessSchema.json');

function describeSchema(schema) {
  const out = {};
  schema.eachPath((p, type) => {
    const opts = { ...type.options };
    delete opts.type;
    if (typeof opts.default === 'function') opts.default = '<fn>';
    out[p] = { instance: type.instance, ...opts };
  });
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

test('Business schema fields are unchanged', () => {
  const Business = load('models/Business', 'core/models/Business');
  const current = JSON.stringify(describeSchema(Business.schema), null, 2) + '\n';
  if (process.env.UPDATE_SNAPSHOT || !fs.existsSync(SNAPSHOT)) {
    fs.writeFileSync(SNAPSHOT, current);
    return;
  }
  assert.equal(current, fs.readFileSync(SNAPSHOT, 'utf8'));
});
