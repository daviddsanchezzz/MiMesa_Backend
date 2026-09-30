const router = require('express').Router();
const { me, getPublicBusiness, getBusinessLogo, updateBusinessSettings } = require('../controllers/authController');
const requireAuth    = require('../middleware/requireAuth');
const requireSession = require('../middleware/requireSession');
const requireRole    = require('../middleware/requireRole');

// Sign-in / sign-up / sessions are handled by Better Auth under /api/betterauth/*.
router.get('/me', requireSession, me);
router.put('/settings', requireAuth, requireRole('manager'), updateBusinessSettings);

// Public route
router.get('/public/business/:id', getPublicBusiness);
router.get('/public/business/:id/logo', getBusinessLogo);

module.exports = router;
