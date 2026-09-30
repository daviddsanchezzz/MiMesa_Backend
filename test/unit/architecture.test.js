/**
 * Architecture rule: core/ is shared by every product and must not depend on
 * modules/ or verticals/; modules/ must not depend on verticals/.
 *
 * KNOWN_DEBT lists the imports that still break the rule today. They need a
 * behaviour change (hooks/events) to remove, so they are frozen here: the list
 * may only shrink. Adding a new cross-layer import makes this test fail.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../helpers/load');

const KNOWN_DEBT = [
  // Customer history and merge read/update reservations.
  'core/controllers/customerController.js -> verticals/restaurant/models/Reservation',
  // Dev console counts reservations per business.
  'core/controllers/devController.js -> verticals/restaurant/models/Reservation',
  // Stripe webhook handles reservation deposits.
  'core/controllers/stripeController.js -> verticals/restaurant/lib/reservationLimits',
  'core/controllers/stripeController.js -> verticals/restaurant/models/Reservation',
  'core/routes/stripe.js -> verticals/restaurant/controllers/reservationPaymentController',
  // Revenue estimates use covers from reservations.
  'modules/finance/controllers/revenueController.js -> verticals/restaurant/models/Reservation',
  // Staff assignments point at restaurant service shifts.
  'modules/staff/controllers/staffController.js -> verticals/restaurant/models/Shift',
  'modules/staff/lib/staffCosts.js -> verticals/restaurant/models/Shift',
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
}

function crossLayerImports() {
  const found = [];
  for (const layer of ['core', 'modules']) {
    const forbidden = layer === 'core' ? /^(modules|verticals)\// : /^verticals\//;
    for (const file of walk(path.join(ROOT, layer))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)) {
        const target = path.relative(ROOT, path.resolve(path.dirname(file), m[2])).split(path.sep).join('/');
        if (forbidden.test(target)) found.push(`${path.relative(ROOT, file).split(path.sep).join('/')} -> ${target}`);
      }
    }
  }
  return [...new Set(found)].sort();
}

test('no new imports from core into modules/verticals (or modules into verticals)', () => {
  const unexpected = crossLayerImports().filter((i) => !KNOWN_DEBT.includes(i));
  assert.deepEqual(unexpected, []);
});

test('known debt list is up to date (remove entries once fixed)', () => {
  const current = new Set(crossLayerImports());
  const fixed = KNOWN_DEBT.filter((i) => !current.has(i));
  assert.deepEqual(fixed, [], 'these imports are gone: delete them from KNOWN_DEBT');
});
