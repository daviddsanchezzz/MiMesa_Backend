const router = require('express').Router();
const requireAuth   = require('../middleware/requireAuth');
const requireRole   = require('../middleware/requireRole');
const requireModule = require('../middleware/requireModule');
const c = require('../controllers/revenueController');

router.use(requireAuth, requireRole('manager'), requireModule('expenses'));

router.get('/dashboard',          c.getDashboard);
router.put('/actual',             c.upsertActual);
router.put('/ticket-average',     c.updateTicketAverage);

module.exports = router;
