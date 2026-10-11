/**
 * Node mints a short-lived JWT so ai-service knows which business/agent type
 * it's acting for, without trusting anything the caller sends directly
 * (docs/VETRA_AI_ARCHITECTURE.md §6). These tests cover the Node side of
 * that contract: minting and verifying must agree, and verification must
 * reject anything that isn't exactly what Node issued.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { lib } = require('../helpers/load');

describe('aiServiceAuth', () => {
  let originalSecret;

  before(() => {
    originalSecret = process.env.AI_SERVICE_JWT_SECRET;
    process.env.AI_SERVICE_JWT_SECRET = 'test-secret-do-not-use-in-prod';
  });

  after(() => {
    process.env.AI_SERVICE_JWT_SECRET = originalSecret;
  });

  // Re-require after setting the env var so the module reads the right secret.
  const load = () => {
    delete require.cache[require.resolve('../../core/lib/aiServiceAuth')];
    return lib('aiServiceAuth');
  };

  test('mints a token that verifies back to the same claims', () => {
    const { mintAgentContextToken, verifyAgentContextToken, AGENT_TYPES } = load();
    const token = mintAgentContextToken({ businessId: 'biz1', agentType: AGENT_TYPES.BUSINESS_COPILOT, userId: 'user1' });

    const ctx = verifyAgentContextToken(token);

    assert.equal(ctx.businessId, 'biz1');
    assert.equal(ctx.agentType, AGENT_TYPES.BUSINESS_COPILOT);
    assert.equal(ctx.userId, 'user1');
  });

  test('the public agent has no userId', () => {
    const { mintAgentContextToken, verifyAgentContextToken, AGENT_TYPES } = load();
    const token = mintAgentContextToken({ businessId: 'biz1', agentType: AGENT_TYPES.PUBLIC_BOOKING_AGENT });

    const ctx = verifyAgentContextToken(token);

    assert.equal(ctx.agentType, AGENT_TYPES.PUBLIC_BOOKING_AGENT);
    assert.equal(ctx.userId, null);
  });

  test('rejects an unknown agentType at mint time (no client-controlled elevation)', () => {
    const { mintAgentContextToken } = load();
    assert.throws(() => mintAgentContextToken({ businessId: 'biz1', agentType: 'SUPERADMIN_AGENT' }));
  });

  test('rejects a token signed with a different secret', () => {
    const { verifyAgentContextToken, AGENT_TYPES } = load();
    const forged = jwt.sign(
      { businessId: 'biz1', agentType: AGENT_TYPES.BUSINESS_COPILOT, userId: 'attacker' },
      'wrong-secret',
      { issuer: 'vetra-node', audience: 'vetra-ai-service', expiresIn: '5m' }
    );

    assert.throws(() => verifyAgentContextToken(forged));
  });

  test('rejects a token with the wrong audience', () => {
    const { verifyAgentContextToken } = load();
    const token = jwt.sign(
      { businessId: 'biz1', agentType: 'BUSINESS_COPILOT', userId: 'u1' },
      process.env.AI_SERVICE_JWT_SECRET,
      { issuer: 'vetra-node', audience: 'some-other-service', expiresIn: '5m' }
    );

    assert.throws(() => verifyAgentContextToken(token));
  });

  test('rejects a token with the wrong issuer', () => {
    const { verifyAgentContextToken } = load();
    const token = jwt.sign(
      { businessId: 'biz1', agentType: 'BUSINESS_COPILOT', userId: 'u1' },
      process.env.AI_SERVICE_JWT_SECRET,
      { issuer: 'someone-else', audience: 'vetra-ai-service', expiresIn: '5m' }
    );

    assert.throws(() => verifyAgentContextToken(token));
  });

  test('rejects an expired token', () => {
    const { verifyAgentContextToken } = load();
    const token = jwt.sign(
      { businessId: 'biz1', agentType: 'BUSINESS_COPILOT', userId: 'u1' },
      process.env.AI_SERVICE_JWT_SECRET,
      { issuer: 'vetra-node', audience: 'vetra-ai-service', expiresIn: '-1s' }
    );

    assert.throws(() => verifyAgentContextToken(token));
  });

  test('defaults to a short expiry (<= 5 minutes)', () => {
    const { mintAgentContextToken, AGENT_TYPES } = load();
    const token = mintAgentContextToken({ businessId: 'biz1', agentType: AGENT_TYPES.PUBLIC_BOOKING_AGENT });
    const decoded = jwt.decode(token);

    assert.ok(decoded.exp - decoded.iat <= 300);
  });
});
