const router      = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const requirePlan = require('../middleware/requirePlan');
const c           = require('../controllers/stripeController');

// NOTE: /webhook is mounted directly in server.js with express.raw() BEFORE express.json().
// Do NOT add it here or the body will already be parsed and signature verification will fail.

// Billing status — owner only (no role restriction on GET for visibility)
router.get('/status',      requireAuth,                    c.getBillingStatus);

// Protected billing endpoints — owner only
router.post('/checkout',   requireAuth, requireRole('owner'), c.createCheckoutSession);
router.post('/portal',     requireAuth, requireRole('owner'), c.createPortalSession);
router.post('/cancel',     requireAuth, requireRole('owner'), c.cancelSubscription);
router.post('/reactivate', requireAuth, requireRole('owner'), c.reactivateSubscription);

// ── Stripe Connect (pagos de clientes al restaurante) ─────────────────────
// Callback es público — Stripe redirige aquí sin sesión de usuario
router.get('/connect/callback',           c.handleConnectCallback);
router.get('/connect/status',             requireAuth,                                                        c.getConnectStatus);
router.post('/connect/onboarding-url',    requireAuth, requireRole('owner'), requirePlan('reservationPayments'), c.getConnectOnboardingUrl);
router.delete('/connect',                 requireAuth, requireRole('owner'), requirePlan('reservationPayments'), c.disconnectConnect);
router.put('/connect/payment-settings',   requireAuth, requireRole('owner'), requirePlan('reservationPayments'), c.updatePaymentSettings);

module.exports = router;
