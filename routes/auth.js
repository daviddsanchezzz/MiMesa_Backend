const router = require('express').Router();
const { register, login, refresh, logout, me, getPublicBusiness, updateBusinessSettings } = require('../controllers/authController');
const requireAuth    = require('../middleware/requireAuth');
const requireSession = require('../middleware/requireSession');

// Legacy endpoints — kept for backward compatibility during migration.
// New clients should use /api/betterauth/* instead.
router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
// /me and /settings accept both Better Auth sessions and legacy JWT
router.get('/me', requireSession, me);
router.put('/settings', requireAuth, updateBusinessSettings);

// Public route
router.get('/public/business/:id', getPublicBusiness);

module.exports = router;
