/**
 * POST /api/ai/session (private) and POST /api/ai/public/session (public)
 * are the only place agentType/businessId get decided — never from
 * anything the client sends (docs/VETRA_AI_ARCHITECTURE.md §3, §6).
 *
 * Uses an in-memory MongoDB so it runs without MONGO_TEST_URI.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');
const { testKeyPair } = require('../helpers/aiServiceKeys');

describe('AI session minting routes', () => {
  let mongoose, mongod, app;
  let Business, BusinessMember;
  let verifyAgentContextToken, AGENT_TYPES;
  let originalPrivate, originalPublic;

  before(async () => {
    const { privateKey, publicKey } = testKeyPair();
    originalPrivate = process.env.AI_SERVICE_JWT_PRIVATE_KEY;
    originalPublic = process.env.AI_SERVICE_JWT_PUBLIC_KEY;
    process.env.AI_SERVICE_JWT_PRIVATE_KEY = privateKey;
    process.env.AI_SERVICE_JWT_PUBLIC_KEY = publicKey;

    installFakeAuth();
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    mongoose = require('mongoose');
    await mongoose.connect(mongod.getUri(), { dbName: 'vetra_ai_session_routes_test' });

    const mod = require(path.join(ROOT, 'app'));
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;

    Business = require(path.join(ROOT, 'core/models/Business'));
    BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    ({ verifyAgentContextToken, AGENT_TYPES } = require(path.join(ROOT, 'core/lib/aiServiceAuth')));

    addUser({ id: 'owner1' });
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    process.env.AI_SERVICE_JWT_PRIVATE_KEY = originalPrivate;
    process.env.AI_SERVICE_JWT_PUBLIC_KEY = originalPublic;
  });

  beforeEach(async () => {
    await Promise.all([Business.deleteMany({}), BusinessMember.deleteMany({})]);
  });

  describe('POST /api/ai/session (private, BUSINESS_COPILOT)', () => {
    test('mints a token for the authenticated user\'s active business', async () => {
      const business = await Business.create({ name: 'Rest Test', email: `rest-${Date.now()}@example.test`, plan: 'pro', subscriptionStatus: 'active' });
      await BusinessMember.create({ userId: 'owner1', businessId: business._id, role: 'owner' });

      const res = await request(app).post('/api/ai/session').set('x-test-user', 'owner1');

      assert.equal(res.status, 200);
      assert.ok(res.body.contextToken);
      const ctx = verifyAgentContextToken(res.body.contextToken);
      assert.equal(ctx.agentType, AGENT_TYPES.BUSINESS_COPILOT);
      assert.equal(ctx.businessId, String(business._id));
      assert.equal(ctx.userId, 'owner1');
    });

    test('rejects an unauthenticated request', async () => {
      const res = await request(app).post('/api/ai/session');
      assert.equal(res.status, 401);
    });
  });

  describe('POST /api/ai/public/session (public, PUBLIC_BOOKING_AGENT)', () => {
    test('mints a token for a business found by slug, with no userId', async () => {
      const business = await Business.create({ name: 'Rest Public', email: `pub-${Date.now()}@example.test`, plan: 'free', subscriptionStatus: 'active', businessType: 'restaurant' });

      const res = await request(app).post('/api/ai/public/session').send({ businessSlug: business.slug });

      assert.equal(res.status, 200);
      const ctx = verifyAgentContextToken(res.body.contextToken);
      assert.equal(ctx.agentType, AGENT_TYPES.PUBLIC_BOOKING_AGENT);
      assert.equal(ctx.businessId, String(business._id));
      assert.equal(ctx.userId, null);
    });

    test('404s for a slug that does not exist', async () => {
      const res = await request(app).post('/api/ai/public/session').send({ businessSlug: 'no-existe-este-negocio' });
      assert.equal(res.status, 404);
    });

    test('rejects an appointments business with the bookings module disabled', async () => {
      const business = await Business.create({
        name: 'Salon Test', email: `salon-${Date.now()}@example.test`, plan: 'free', subscriptionStatus: 'active',
        businessType: 'appointments', moduleOverrides: { bookings: { enabled: false } },
      });

      const res = await request(app).post('/api/ai/public/session').send({ businessSlug: business.slug });
      assert.equal(res.status, 403);
    });
  });
});
