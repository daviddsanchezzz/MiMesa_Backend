/**
 * Mints the short-lived agent-context JWT (docs/VETRA_AI_ARCHITECTURE.md §3, §6).
 * This is the ONLY place agentType/businessId get decided — never from
 * anything the client sends directly, and never forwarded as-is from a
 * client-controlled value.
 */
const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const Business = require('../models/Business');
const { findBusinessBySlug } = require('../lib/slugs');
const { canUseModule } = require('../lib/planCapabilities');
const { mintAgentContextToken, AGENT_TYPES } = require('../lib/aiServiceAuth');

// POST /api/ai/session — authenticated dashboard user opens a BUSINESS_COPILOT session.
router.post('/session', requireAuth, (req, res) => {
  const contextToken = mintAgentContextToken({
    businessId: req.businessId,
    agentType: AGENT_TYPES.BUSINESS_COPILOT,
    userId: req.user.id,
  });
  res.json({ contextToken });
});

const BUSINESS_SELECT = '_id slug businessType plan subscriptionStatus legacyAccess paymentFailedAt trialEndsAt stripeSubscriptionId moduleOverrides';

// POST /api/ai/public/session — a public visitor opens a PUBLIC_BOOKING_AGENT session.
router.post('/public/session', async (req, res) => {
  try {
    const business = await findBusinessBySlug(Business, req.body?.businessSlug, BUSINESS_SELECT);
    if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

    // Appointments businesses opt in to the bookings module; restaurants always have reservations.
    if (business.businessType === 'appointments' && !canUseModule(business, 'bookings')) {
      return res.status(403).json({ message: 'Las reservas online no estan activas para este negocio' });
    }

    const contextToken = mintAgentContextToken({
      businessId: String(business._id),
      agentType: AGENT_TYPES.PUBLIC_BOOKING_AGENT,
    });
    res.json({ contextToken, businessType: business.businessType || 'restaurant' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
