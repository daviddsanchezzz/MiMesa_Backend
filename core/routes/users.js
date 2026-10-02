const router = require('express').Router();
const requireSession = require('../middleware/requireSession');
const c = require('../controllers/usersController');

router.use(requireSession);

router.get('/me', c.getMe);
router.put('/me', c.updateMe);
router.put('/me/password', c.updatePassword);
router.put('/me/memberships/:membershipId/notifications', c.updateMembershipNotifications);

module.exports = router;
