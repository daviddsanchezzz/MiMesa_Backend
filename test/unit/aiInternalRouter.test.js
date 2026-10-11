/**
 * /api/internal/ai end-to-end: service token + agent context JWT, and —
 * the key security property from docs/VETRA_AI_ARCHITECTURE.md §6 — a role
 * is never trusted from the token. If the membership is revoked after the
 * token was minted but before it expires, the call must still be rejected.
 *
 * Uses an in-memory MongoDB so it runs without MONGO_TEST_URI.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { ROOT } = require('../helpers/load');
const { testKeyPair } = require('../helpers/aiServiceKeys');

describe('/api/internal/ai', () => {
  let mongoose, mongod, app;
  let Business, BusinessMember;
  let mintAgentContextToken, AGENT_TYPES;
  let business, member;
  let originalServiceToken, originalPrivate, originalPublic;

  before(async () => {
    const { privateKey, publicKey } = testKeyPair();
    originalServiceToken = process.env.AI_SERVICE_TOKEN;
    originalPrivate = process.env.AI_SERVICE_JWT_PRIVATE_KEY;
    originalPublic = process.env.AI_SERVICE_JWT_PUBLIC_KEY;
    process.env.AI_SERVICE_TOKEN = 'test-service-token';
    process.env.AI_SERVICE_JWT_PRIVATE_KEY = privateKey;
    process.env.AI_SERVICE_JWT_PUBLIC_KEY = publicKey;

    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    mongoose = require('mongoose');
    await mongoose.connect(mongod.getUri(), { dbName: 'vetra_ai_internal_router_test' });

    const mod = require(path.join(ROOT, 'app'));
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;

    Business = require(path.join(ROOT, 'core/models/Business'));
    BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    ({ mintAgentContextToken, AGENT_TYPES } = require(path.join(ROOT, 'core/lib/aiServiceAuth')));
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    process.env.AI_SERVICE_TOKEN = originalServiceToken;
    process.env.AI_SERVICE_JWT_PRIVATE_KEY = originalPrivate;
    process.env.AI_SERVICE_JWT_PUBLIC_KEY = originalPublic;
  });

  beforeEach(async () => {
    await Promise.all([Business.deleteMany({}), BusinessMember.deleteMany({})]);
    business = await Business.create({ name: 'Rest Test', email: `rest-${Date.now()}@example.test`, plan: 'free', subscriptionStatus: 'active' });
    member = await BusinessMember.create({ userId: 'user1', businessId: business._id, role: 'manager' });
  });

  function withHeaders(req, { serviceToken = 'test-service-token', agentContext }) {
    if (serviceToken) req = req.set('X-Service-Token', serviceToken);
    if (agentContext) req = req.set('X-Agent-Context', agentContext);
    return req;
  }

  test('rejects without a service token', async () => {
    const token = mintAgentContextToken({ businessId: String(business._id), agentType: AGENT_TYPES.PUBLIC_BOOKING_AGENT });
    const res = await withHeaders(request(app).get('/api/internal/ai/ping'), { serviceToken: null, agentContext: token });
    assert.equal(res.status, 401);
  });

  test('rejects without an agent context', async () => {
    const res = await withHeaders(request(app).get('/api/internal/ai/ping'), {});
    assert.equal(res.status, 401);
  });

  test('ping works for the public agent, with no userId', async () => {
    const token = mintAgentContextToken({ businessId: String(business._id), agentType: AGENT_TYPES.PUBLIC_BOOKING_AGENT });
    const res = await withHeaders(request(app).get('/api/internal/ai/ping'), { agentContext: token });

    assert.equal(res.status, 200);
    assert.equal(res.body.businessId, String(business._id));
    assert.equal(res.body.agentType, 'PUBLIC_BOOKING_AGENT');
    assert.equal(res.body.userId, null);
  });

  test('whoami resolves the live role for a real BUSINESS_COPILOT member', async () => {
    const token = mintAgentContextToken({ businessId: String(business._id), agentType: AGENT_TYPES.BUSINESS_COPILOT, userId: 'user1' });
    const res = await withHeaders(request(app).get('/api/internal/ai/whoami'), { agentContext: token });

    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'manager');
  });

  test('the public agent cannot reach a BUSINESS_COPILOT-only route', async () => {
    const token = mintAgentContextToken({ businessId: String(business._id), agentType: AGENT_TYPES.PUBLIC_BOOKING_AGENT });
    const res = await withHeaders(request(app).get('/api/internal/ai/whoami'), { agentContext: token });

    assert.equal(res.status, 403);
  });

  test('a user with no membership in that business is rejected', async () => {
    const token = mintAgentContextToken({ businessId: String(business._id), agentType: AGENT_TYPES.BUSINESS_COPILOT, userId: 'some-stranger' });
    const res = await withHeaders(request(app).get('/api/internal/ai/whoami'), { agentContext: token });

    assert.equal(res.status, 403);
  });

  test('revoking the membership after the token was minted still blocks the call (role is never cached)', async () => {
    const token = mintAgentContextToken({ businessId: String(business._id), agentType: AGENT_TYPES.BUSINESS_COPILOT, userId: 'user1' });

    // Token is still validly signed and unexpired — only the live membership changed.
    await BusinessMember.deleteOne({ _id: member._id });

    const res = await withHeaders(request(app).get('/api/internal/ai/whoami'), { agentContext: token });
    assert.equal(res.status, 403);
  });
});
