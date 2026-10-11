/**
 * requireServiceToken proves a request to /api/internal/ai/* came from the
 * real ai-service (shared secret), before anything looks at the agent
 * context JWT (docs/VETRA_AI_ARCHITECTURE.md §6).
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = '../../core/middleware/requireServiceToken';

describe('requireServiceToken', () => {
  let originalToken;
  let requireServiceToken;

  before(() => {
    originalToken = process.env.AI_SERVICE_TOKEN;
  });

  after(() => {
    process.env.AI_SERVICE_TOKEN = originalToken;
  });

  beforeEach(() => {
    process.env.AI_SERVICE_TOKEN = 'the-real-token';
    delete require.cache[require.resolve(MODULE_PATH)];
    requireServiceToken = require(MODULE_PATH);
  });

  function run(headerValue) {
    const req = { headers: headerValue !== undefined ? { 'x-service-token': headerValue } : {} };
    let statusCode = null, body = null, nextCalled = false;
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; return this; },
    };
    requireServiceToken(req, res, () => { nextCalled = true; });
    return { statusCode, body, nextCalled };
  }

  test('allows a request with the correct token', () => {
    const { nextCalled, statusCode } = run('the-real-token');
    assert.equal(nextCalled, true);
    assert.equal(statusCode, null);
  });

  test('rejects a wrong token', () => {
    const { nextCalled, statusCode } = run('guessed-token');
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });

  test('rejects a missing token', () => {
    const { nextCalled, statusCode } = run(undefined);
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });

  test('rejects a token of a different length without throwing', () => {
    assert.doesNotThrow(() => run('short'));
    const { nextCalled } = run('short');
    assert.equal(nextCalled, false);
  });

  test('fails closed when AI_SERVICE_TOKEN is not configured, even if headers match something falsy', () => {
    delete process.env.AI_SERVICE_TOKEN;
    delete require.cache[require.resolve(MODULE_PATH)];
    requireServiceToken = require(MODULE_PATH);

    const { nextCalled, statusCode } = run('');
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });
});
