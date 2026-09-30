/**
 * HTTP-level checks that need no database:
 *  - every private endpoint rejects anonymous requests (401)
 *  - the public reservation endpoint validates its input before touching data
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { installFakeAuth } = require('../helpers/fakeAuth');

let app;
before(() => {
  installFakeAuth();
  const mod = require('../../app');
  mod.mountAuthAndErrorHandlers(function betterAuthHandler(req, res) { res.status(418).end(); });
  app = mod.app;
});

// Endpoints that are intentionally reachable without a session.
const PUBLIC = [
  /^\/api\/[a-z]+\/public(\/|$)/,
  /^\/api\/contact/,
  /^\/api\/stripe\/webhook$/,
  /^\/api\/webhooks\/stripe$/,
  /^\/api\/health$/,
  /^\/api\/betterauth\//,
  /^\/api\/push\/vapid-public-key$/,
  /^\/api\/invitations\/info\//,
  /^\/api\/invitations\/accept\//, // the invite token is the credential (see routes/invitations.js)
  /^\/api\/pricing\/plans$/,
];

function listRoutes(stack, prefix = '', out = []) {
  for (const layer of stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) out.push({ method: m, path: prefix + layer.route.path });
    } else if (layer.name === 'router' && layer.handle.stack) {
      const p = layer.regexp.fast_slash ? '' : layer.regexp.source.replace('\\/?(?=\\/|$)', '').replace(/^\^/, '').replace(/\\\//g, '/');
      listRoutes(layer.handle.stack, prefix + p, out);
    }
  }
  return out;
}

describe('access control', () => {
  test('every private endpoint answers 401 to anonymous requests', async () => {
    const routes = listRoutes(app._router.stack)
      .filter((r) => r.path.startsWith('/api/'))
      .filter((r) => !PUBLIC.some((re) => re.test(r.path)));
    assert.ok(routes.length > 100, `expected many private routes, got ${routes.length}`);

    const failures = [];
    for (const r of routes) {
      const url = r.path.replace(/:[A-Za-z]+/g, '000000000000000000000000');
      const res = await request(app)[r.method](url).send({});
      if (res.status !== 401) failures.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    assert.deepEqual(failures, []);
  });
});

describe('public reservation input validation', () => {
  const valid = {
    businessId: '64b000000000000000000001',
    guestName: 'Ana',
    guestPhone: '612345678',
    guestEmail: 'ana@example.test',
    date: '2026-10-17',
    time: '21:00',
    people: 2,
  };
  const cases = [
    ['missing phone', { guestPhone: '' }, 'El telefono es obligatorio'],
    ['missing email', { guestEmail: '' }, 'El email es obligatorio'],
    ['bad business id', { businessId: 'abc' }, 'Restaurante no valido'],
    ['empty name', { guestName: '   ' }, 'Nombre no valido'],
    ['bad email', { guestEmail: 'not-an-email' }, 'Email o telefono no validos'],
    ['bad date', { date: '17/10/2026' }, 'Fecha u hora no validas'],
    ['bad time', { time: '9pm' }, 'Fecha u hora no validas'],
    ['zero people', { people: 0 }, 'Numero de personas no valido'],
    ['too many people', { people: 501 }, 'Numero de personas no valido'],
    ['huge notes', { notes: 'x'.repeat(1001) }, 'Las notas son demasiado largas'],
  ];
  for (const [name, patch, message] of cases) {
    test(name, async () => {
      const res = await request(app).post('/api/reservations/public').send({ ...valid, ...patch });
      assert.equal(res.status, 400);
      assert.equal(res.body.message, message);
    });
  }
});

// ── Public routes answer any origin (vetrareserve.com/{slug}, business websites) ──
const { test: t3 } = require('node:test');
const assert3 = require('node:assert/strict');
t3('public endpoints are not blocked by the app-only CORS', async () => {
  const request = require('supertest');
  const { app } = require('../../app');
  const res = await request(app).get('/api/pricing/public').set('Origin', 'https://www.vetrareserve.com');
  assert3.notEqual(res.status, 403, 'not blocked');
  assert3.equal(res.headers['access-control-allow-origin'], '*');
  const pre = await request(app).options('/api/auth/public/business-by-slug/x').set('Origin', 'https://www.vetrareserve.com').set('Access-Control-Request-Method', 'GET');
  assert3.equal(pre.status, 204);
  assert3.equal(pre.headers['access-control-allow-origin'], '*');
  const priv = await request(app).get('/api/customers').set('Origin', 'https://evil.example');
  assert3.notEqual(priv.headers['access-control-allow-origin'], '*', 'private routes keep the app-only CORS');
});
