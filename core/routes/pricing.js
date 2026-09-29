const router = require('express').Router();
const c = require('../controllers/pricingController');

// Public — no auth, CORS * applied in server.js
router.get('/public', c.getPublicPricing);

module.exports = router;
