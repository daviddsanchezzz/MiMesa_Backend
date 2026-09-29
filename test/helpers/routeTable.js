/**
 * Builds a stable, human-readable list of every endpoint the Express app exposes,
 * including the middleware and controller each one runs, e.g.
 *   GET /api/staff/positions  [staffController.getPositions]
 *   USE /api/staff/  [requireRole(manager)]
 *
 * Used by the route snapshot test: any refactor that moves files around must
 * leave this list identical, so a missing route or a dropped auth check fails.
 * Names use the file's basename (not its folder), so moving a file is fine as
 * long as its name and exports stay the same.
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const FACTORIES = ['requireRole', 'requireModule', 'requireAnyModule', 'requirePlan'];

/**
 * Middleware factories (requireRole('manager')) return anonymous closures.
 * Wrap them before the app is loaded so each closure is named after its call,
 * e.g. "requireRole(manager)". Must run before require('../app').
 */
function instrumentMiddlewareFactories(resolveFactory) {
  for (const name of FACTORIES) {
    const file = resolveFactory(name);
    if (!file) continue;
    const mod = require(file);
    const factory = typeof mod === 'function' ? mod : mod[name];
    if (typeof factory !== 'function') continue;
    const wrapped = function (...args) {
      const fn = factory(...args);
      Object.defineProperty(fn, 'name', { value: `${name}(${args.map((a) => JSON.stringify(a)).join(',')})` });
      return fn;
    };
    require.cache[require.resolve(file)].exports = typeof mod === 'function' ? wrapped : { ...mod, [name]: wrapped };
  }
}

// Reverse map: exported function → "fileBasename.exportName" for every project module loaded.
function buildNameIndex() {
  const index = new Map();
  for (const [file, mod] of Object.entries(require.cache)) {
    if (!file.startsWith(ROOT) || file.includes(`${path.sep}node_modules${path.sep}`) || file.includes(`${path.sep}test${path.sep}`)) continue;
    const base = path.basename(file, '.js');
    const exp = mod.exports;
    if (typeof exp === 'function' && !index.has(exp)) index.set(exp, exp.name || base);
    if (exp && typeof exp === 'object') {
      for (const [key, value] of Object.entries(exp)) {
        if (typeof value === 'function' && !index.has(value)) index.set(value, `${base}.${key}`);
      }
    }
  }
  return index;
}

function prefixFromRegexp(regexp) {
  if (regexp.fast_slash) return '';
  return regexp.source
    .replace('\\/?(?=\\/|$)', '')
    .replace(/^\^/, '')
    .replace(/\\\//g, '/');
}

function collect(stack, prefix, names, out) {
  const nameOf = (fn) => names.get(fn) || (fn.name && fn.name !== 'anonymous' ? fn.name : '<anon>');
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase()).sort();
      const chain = layer.route.stack.map((l) => nameOf(l.handle));
      for (const method of methods) out.push(`${method} ${prefix}${layer.route.path}  [${chain.join(' > ')}]`);
    } else if (layer.name === 'router' && layer.handle.stack) {
      collect(layer.handle.stack, prefix + prefixFromRegexp(layer.regexp), names, out);
    } else {
      out.push(`USE ${prefix}${prefixFromRegexp(layer.regexp) || '/'}  [${nameOf(layer.handle)}]`);
    }
  }
  return out;
}

function routeTable(app) {
  return collect(app._router.stack, '', buildNameIndex(), []);
}

module.exports = { routeTable, instrumentMiddlewareFactories };
