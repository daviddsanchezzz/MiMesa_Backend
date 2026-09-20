const router      = require('express').Router();
const auth        = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const requirePlan = require('../middleware/requirePlan');
const mc          = require('../controllers/marketingController');

// Public — no auth needed
router.get('/public/unsubscribe', mc.unsubscribe);

// Authenticated
router.use(auth, requireRole('manager'));
router.get('/subscribers', mc.getSubscribers);
router.get('/campaigns',   mc.getCampaigns);
router.post('/send',       requirePlan('marketing'), mc.sendCampaign);

module.exports = router;
