/**
 * requireAgentContext verifies the X-Agent-Context JWT ai-service forwards
 * on every /api/internal/ai/* call and turns it into req.businessId/
 * req.agentType (+ req.user for BUSINESS_COPILOT), so downstream routes can
 * reuse the existing requireRole/requireBusinessAccess middleware instead of
 * duplicating permission logic (docs/VETRA_AI_ARCHITECTURE.md §6).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('requireAgentContext', () => {
  let originalSecret;
  let requireAgentContext, mintAgentContextToken, AGENT_TYPES;

  before(() => {
    originalSecret = process.env.AI_SERVICE_JWT_SECRET;
    process.env.AI_SERVICE_JWT_SECRET = 'test-secret-do-not-use-in-prod';
    delete require.cache[require.resolve('../../core/lib/aiServiceAuth')];
    delete require.cache[require.resolve('../../core/middleware/requireAgentContext')];
    ({ mintAgentContextToken, AGENT_TYPES } = require('../../core/lib/aiServiceAuth'));
    requireAgentContext = require('../../core/middleware/requireAgentContext');
  });

  after(() => {
    process.env.AI_SERVICE_JWT_SECRET = originalSecret;
  });

  function run(headerValue) {
    const req = { headers: headerValue !== undefined ? { 'x-agent-context': headerValue } : {} };
    let statusCode = null, body = null, nextCalled = false;
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; return this; },
    };
    requireAgentContext(req, res, () => { nextCalled = true; });
    return { req, statusCode, body, nextCalled };
  }

  test('a valid BUSINESS_COPILOT token sets businessId, agentType and user.id', () => {
    const token = mintAgentContextToken({ businessId: 'biz1', agentType: AGENT_TYPES.BUSINESS_COPILOT, userId: 'user1' });
    const { req, nextCalled } = run(token);

    assert.equal(nextCalled, true);
    assert.equal(req.businessId, 'biz1');
    assert.equal(req.agentType, AGENT_TYPES.BUSINESS_COPILOT);
    assert.equal(req.user.id, 'user1');
  });

  test('a valid PUBLIC_BOOKING_AGENT token sets businessId/agentType but no req.user', () => {
    const token = mintAgentContextToken({ businessId: 'biz1', agentType: AGENT_TYPES.PUBLIC_BOOKING_AGENT });
    const { req, nextCalled } = run(token);

    assert.equal(nextCalled, true);
    assert.equal(req.businessId, 'biz1');
    assert.equal(req.agentType, AGENT_TYPES.PUBLIC_BOOKING_AGENT);
    assert.equal(req.user, undefined);
  });

  test('rejects a missing token', () => {
    const { nextCalled, statusCode } = run(undefined);
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });

  test('rejects a garbage token', () => {
    const { nextCalled, statusCode } = run('not-a-jwt');
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });
});
