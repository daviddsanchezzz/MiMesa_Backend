/**
 * requireAgentType(expected) — restricts an /api/internal/ai/* route to one
 * agent type (docs/VETRA_AI_ARCHITECTURE.md §4). Must run after
 * requireAgentContext, which sets req.agentType from the verified JWT —
 * never from anything the caller passes directly.
 */
module.exports = function requireAgentType(expected) {
  return (req, res, next) => {
    if (req.agentType !== expected) {
      return res.status(403).json({ message: `Esta ruta requiere agentType ${expected}` });
    }
    next();
  };
};
