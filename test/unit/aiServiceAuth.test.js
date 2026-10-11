/**
 * Node mints a short-lived JWT so ai-service knows which business/agent type
 * it's acting for, without trusting anything the caller sends directly
 * (docs/VETRA_AI_ARCHITECTURE.md §6). These tests cover the Node side of
 * that contract: minting and verifying must agree, and verification must
 * reject anything that isn't exactly what Node issued.
 *
 * Signing is asymmetric (RS256), not a shared HMAC secret: ai-service only
 * ever holds the PUBLIC key, so even a fully compromised ai-service cannot
 * mint a token Node will accept — only Node, holding the private key, can
 * (found by a background security review: a shared secret would let the
 * verifier forge tokens too).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { lib } = require('../helpers/load');
const { testKeyPair } = require('../helpers/aiServiceKeys');

describe('aiServiceAuth', () => {
  let originalPrivate, originalPublic;
  const { privateKey, publicKey } = testKeyPair();

  before(() => {
    originalPrivate = process.env.AI_SERVICE_JWT_PRIVATE_KEY;
    originalPublic = process.env.AI_SERVICE_JWT_PUBLIC_KEY;
    process.env.AI_SERVICE_JWT_PRIVATE_KEY = privateKey;
    process.env.AI_SERVICE_JWT_PUBLIC_KEY = publicKey;
  });

  after(() => {
    process.env.AI_SERVICE_JWT_PRIVATE_KEY = originalPrivate;
    process.env.AI_SERVICE_JWT_PUBLIC_KEY = originalPublic;
  });

  // Re-require after setting the env vars so the module reads the right keys.
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

  test('is actually asymmetric: signs with RS256, not a shared HMAC secret', () => {
    const { mintAgentContextToken } = load();
    const token = mintAgentContextToken({ businessId: 'biz1', agentType: 'BUSINESS_COPILOT', userId: 'u1' });
    const decoded = jwt.decode(token, { complete: true });
    assert.equal(decoded.header.alg, 'RS256');
  });

  test('a token forged with an unrelated keypair is rejected', () => {
    const { verifyAgentContextToken } = load();
    const forgedPair = require('node:crypto').generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const forged = jwt.sign(
      { businessId: 'biz1', agentType: 'BUSINESS_COPILOT', userId: 'attacker' },
      forgedPair.privateKey,
      { algorithm: 'RS256', issuer: 'vetra-node', audience: 'vetra-ai-service', expiresIn: '5m' }
    );

    assert.throws(() => verifyAgentContextToken(forged));
  });

  test('SECURITY: rejects an algorithm-confusion token (HS256 signed with the PUBLIC key as the "secret")', () => {
    // ai-service only ever holds the public key. If it (or an attacker who
    // extracted it) could get verify() to accept HS256 using that public
    // key as an HMAC secret, the public key would become forgeable —
    // exactly the vulnerability this RS256 switch exists to close.
    const { verifyAgentContextToken } = load();
    const confused = jwt.sign(
      { businessId: 'biz1', agentType: 'BUSINESS_COPILOT', userId: 'attacker' },
      publicKey,
      { algorithm: 'HS256', issuer: 'vetra-node', audience: 'vetra-ai-service', expiresIn: '5m' }
    );

    assert.throws(() => verifyAgentContextToken(confused));
  });

  test('rejects a token with the wrong audience', () => {
    const { verifyAgentContextToken } = load();
    const token = jwt.sign(
      { businessId: 'biz1', agentType: 'BUSINESS_COPILOT', userId: 'u1' },
      privateKey,
      { algorithm: 'RS256', issuer: 'vetra-node', audience: 'some-other-service', expiresIn: '5m' }
    );

    assert.throws(() => verifyAgentContextToken(token));
  });

  test('rejects a token with the wrong issuer', () => {
    const { verifyAgentContextToken } = load();
    const token = jwt.sign(
      { businessId: 'biz1', agentType: 'BUSINESS_COPILOT', userId: 'u1' },
      privateKey,
      { algorithm: 'RS256', issuer: 'someone-else', audience: 'vetra-ai-service', expiresIn: '5m' }
    );

    assert.throws(() => verifyAgentContextToken(token));
  });

  test('rejects an expired token', () => {
    const { verifyAgentContextToken } = load();
    const token = jwt.sign(
      { businessId: 'biz1', agentType: 'BUSINESS_COPILOT', userId: 'u1' },
      privateKey,
      { algorithm: 'RS256', issuer: 'vetra-node', audience: 'vetra-ai-service', expiresIn: '-1s' }
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
