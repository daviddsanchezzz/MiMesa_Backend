const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const stripeController = require('../controllers/stripeController');
const reservationPaymentController = require('../controllers/reservationPaymentController');

router.get('/status', requireAuth, stripeController.getBillingStatus);

router.post('/checkout', requireAuth, requireRole('owner'), stripeController.createCheckoutSession);
router.post('/portal', requireAuth, requireRole('owner'), stripeController.createPortalSession);
router.post('/cancel', requireAuth, requireRole('owner'), stripeController.cancelSubscription);
router.post('/reactivate', requireAuth, requireRole('owner'), stripeController.reactivateSubscription);
router.post('/change-plan', requireAuth, requireRole('owner'), stripeController.changePlan);

router.get('/payment-settings', requireAuth, requireRole('owner'), stripeController.getPaymentSettings);
router.put('/payment-settings', requireAuth, requireRole('owner'), reservationPaymentController.updatePaymentSettings);

module.exports = router;
