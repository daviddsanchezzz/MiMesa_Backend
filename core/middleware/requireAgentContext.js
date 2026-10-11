/**
 * requireAgentContext — verifies the X-Agent-Context JWT ai-service forwards
 * on every /api/internal/ai/* call (docs/VETRA_AI_ARCHITECTURE.md §6).
 * Must run after requireServiceToken.
 *
 * Sets req.businessId/req.agentType, and for BUSINESS_COPILOT also
 * req.user = { id: userId } — nothing more. That lets routes reuse the
 * existing requireBusinessAccess/requireRole middleware unmodified: those
 * always re-resolve the role from BusinessMember themselves, so a role is
 * never trusted from the token.
 */
const { verifyAgentContextToken, AGENT_TYPES } = require('../lib/aiServiceAuth');

module.exports = function requireAgentContext(req, res, next) {
  const token = req.headers['x-agent-context'];
  if (typeof token !== 'string' || !token) {
    return res.status(401).json({ message: 'Falta el contexto del agente' });
  }

  let ctx;
  try {
    ctx = verifyAgentContextToken(token);
  } catch {
    return res.status(401).json({ message: 'Contexto del agente invalido' });
  }

  req.businessId = ctx.businessId;
  req.agentType = ctx.agentType;
  if (ctx.agentType === AGENT_TYPES.BUSINESS_COPILOT && ctx.userId) {
    req.user = { id: ctx.userId };
  }

  next();
};
