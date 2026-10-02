/**
 * Route snapshot: the full list of endpoints + middleware chains must not change
 * during the core/modules refactor. Regenerate intentionally with:
 *   UPDATE_SNAPSHOT=1 npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { routeTable, instrumentMiddlewareFactories } = require('./helpers/routeTable');

const SNAPSHOT = path.join(__dirname, '__snapshots__', 'routes.txt');
const MIDDLEWARE_DIRS = ['../middleware', '../core/middleware'];

test('route table matches snapshot', () => {
  instrumentMiddlewareFactories((name) =>
    MIDDLEWARE_DIRS.map((dir) => path.join(__dirname, dir, `${name}.js`)).find((f) => fs.existsSync(f)));

  const { app, mountAuthAndErrorHandlers } = require('../app');
  mountAuthAndErrorHandlers(function betterAuthHandler(req, res) { res.end(); });
  const table = routeTable(app).join('\n') + '\n';

  if (process.env.UPDATE_SNAPSHOT || !fs.existsSync(SNAPSHOT)) {
    fs.writeFileSync(SNAPSHOT, table);
    return;
  }
  assert.equal(table, fs.readFileSync(SNAPSHOT, 'utf8'));
});
