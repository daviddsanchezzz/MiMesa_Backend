const router      = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
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

module.exports = router;
