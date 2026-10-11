/**
 * Mint/verify the short-lived JWT Node hands to ai-service so it knows
 * which business and agent type a conversation is for
 * (docs/VETRA_AI_ARCHITECTURE.md §6). ai-service never receives
 * businessId/agentType as plain parameters it could tamper with — only
 * this signed, short-lived context.
 *
 * Signed with RS256 (asymmetric), not a shared HMAC secret: Node holds
 * AI_SERVICE_JWT_PRIVATE_KEY and is the only party that can mint a token;
 * ai-service only ever receives AI_SERVICE_JWT_PUBLIC_KEY, which can verify
 * but not forge. A shared symmetric secret would mean a compromised
 * ai-service could mint tokens Node would trust (found by a background
 * security review — see git history for the HS256 version this replaced).
 * `algorithms: [ALGORITHM]` is pinned explicitly on verify to rule out an
 * algorithm-confusion attack (signing HS256 with the public key as if it
 * were the HMAC secret).
 *
 * Deliberately does NOT carry a role claim: the role can change mid-token
 * (e.g. a manager demoted), so every call that needs it re-resolves the
 * live BusinessMember instead of trusting a cached value (see
 * requireAgentContext.js).
 */
const jwt = require('jsonwebtoken');

const ISSUER = 'vetra-node';
const AUDIENCE = 'vetra-ai-service';
const ALGORITHM = 'RS256';
const DEFAULT_TTL_SECONDS = 300;

const AGENT_TYPES = Object.freeze({
  PUBLIC_BOOKING_AGENT: 'PUBLIC_BOOKING_AGENT',
  BUSINESS_COPILOT: 'BUSINESS_COPILOT',
});

function privateKey() {
  const value = process.env.AI_SERVICE_JWT_PRIVATE_KEY;
  if (!value) throw new Error('AI_SERVICE_JWT_PRIVATE_KEY no esta configurado');
  return value;
}

function publicKey() {
  const value = process.env.AI_SERVICE_JWT_PUBLIC_KEY;
  if (!value) throw new Error('AI_SERVICE_JWT_PUBLIC_KEY no esta configurado');
  return value;
}

function mintAgentContextToken({ businessId, agentType, userId = null, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  if (!businessId) throw new Error('businessId es requerido');
  if (!Object.values(AGENT_TYPES).includes(agentType)) throw new Error(`agentType no valido: ${agentType}`);

  return jwt.sign(
    { businessId, agentType, userId },
    privateKey(),
    { algorithm: ALGORITHM, issuer: ISSUER, audience: AUDIENCE, expiresIn: ttlSeconds },
  );
}

function verifyAgentContextToken(token) {
  const payload = jwt.verify(token, publicKey(), { algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE });
  return {
    businessId: payload.businessId,
    agentType: payload.agentType,
    userId: payload.userId ?? null,
  };
}

module.exports = { AGENT_TYPES, mintAgentContextToken, verifyAgentContextToken };
