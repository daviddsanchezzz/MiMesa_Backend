/**
 * Mint/verify the short-lived JWT Node hands to ai-service so it knows
 * which business and agent type a conversation is for
 * (docs/VETRA_AI_ARCHITECTURE.md §6). ai-service never receives
 * businessId/agentType as plain parameters it could tamper with — only
 * this signed, short-lived context.
 *
 * Deliberately does NOT carry a role claim: the role can change mid-token
 * (e.g. a manager demoted), so every call that needs it re-resolves the
 * live BusinessMember instead of trusting a cached value (see
 * requireAgentContext.js).
 */
const jwt = require('jsonwebtoken');

const ISSUER = 'vetra-node';
const AUDIENCE = 'vetra-ai-service';
const DEFAULT_TTL_SECONDS = 300;

const AGENT_TYPES = Object.freeze({
  PUBLIC_BOOKING_AGENT: 'PUBLIC_BOOKING_AGENT',
  BUSINESS_COPILOT: 'BUSINESS_COPILOT',
});

function secret() {
  const value = process.env.AI_SERVICE_JWT_SECRET;
  if (!value) throw new Error('AI_SERVICE_JWT_SECRET no esta configurado');
  return value;
}

function mintAgentContextToken({ businessId, agentType, userId = null, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  if (!businessId) throw new Error('businessId es requerido');
  if (!Object.values(AGENT_TYPES).includes(agentType)) throw new Error(`agentType no valido: ${agentType}`);

  return jwt.sign(
    { businessId, agentType, userId },
    secret(),
    { issuer: ISSUER, audience: AUDIENCE, expiresIn: ttlSeconds },
  );
}

function verifyAgentContextToken(token) {
  const payload = jwt.verify(token, secret(), { issuer: ISSUER, audience: AUDIENCE });
  return {
    businessId: payload.businessId,
    agentType: payload.agentType,
    userId: payload.userId ?? null,
  };
}

module.exports = { AGENT_TYPES, mintAgentContextToken, verifyAgentContextToken };
