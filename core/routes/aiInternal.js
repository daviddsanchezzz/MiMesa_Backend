/**
 * /api/internal/ai — the only door ai-service uses into Node for anything
 * that needs real business permissions (docs/VETRA_AI_ARCHITECTURE.md §6).
 * Public-agent tools don't come through here: they call Node's existing
 * public endpoints directly (see §5), the same ones a browser widget would.
 *
 * Mounted BEFORE requireServiceToken/requireAgentContext at the app.js
 * level is not an option: every route here needs both.
 */
const router = require('express').Router();
const requireServiceToken = require('../middleware/requireServiceToken');
const requireAgentContext = require('../middleware/requireAgentContext');
const requireAgentType = require('../middleware/requireAgentType');
const requireBusinessAccess = require('../middleware/requireBusinessAccess');
const { AGENT_TYPES } = require('../lib/aiServiceAuth');

router.use(requireServiceToken);
router.use(requireAgentContext);

// Proves the chain end-to-end before any real tool exists yet.
router.get('/ping', (req, res) => {
  res.json({ businessId: req.businessId, agentType: req.agentType, userId: req.user?.id || null });
});

// requireBusinessAccess re-queries BusinessMember on every call — the role
// is never trusted from the token, only resolved live (see requireAgentContext.js).
router.get('/whoami', requireAgentType(AGENT_TYPES.BUSINESS_COPILOT), requireBusinessAccess, (req, res) => {
  res.json({ businessId: req.businessId, userId: req.user.id, role: req.memberRole });
});

module.exports = router;
