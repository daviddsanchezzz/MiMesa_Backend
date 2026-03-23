const router      = require('express').Router();
const auth        = require('../middleware/requireAuth');
const requirePlan = require('../middleware/requirePlan');
const mc          = require('../controllers/marketingController');

// Public — no auth needed
router.get('/public/unsubscribe', mc.unsubscribe);

// Authenticated
router.use(auth);
router.get('/subscribers', mc.getSubscribers);
router.get('/campaigns',   mc.getCampaigns);
router.post('/send',       requirePlan('marketing'), mc.sendCampaign);

module.exports = router;
