const router      = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const cors        = require('cors');
const c           = require('../controllers/invitationsController');

// Public — no auth needed (for the AcceptInvite page to fetch details)
router.get('/public/:token',    cors({ origin: '*' }), c.getPublicInvitation);

// Authenticated — accept invitation (user just registered/logged in)
router.post('/accept/:token',   requireAuth, c.acceptInvitation);

// Protected — manage invitations (manager+ to send, owner to cancel)
router.get('/',                 requireAuth, requireRole('manager'), c.listInvitations);
router.post('/',                requireAuth, requireRole('manager'), c.createInvitation);
router.delete('/:id',           requireAuth, requireRole('owner'),   c.cancelInvitation);

module.exports = router;
