const router = require('express').Router();
const requireAuth   = require('../../../core/middleware/requireAuth');
const requireRole   = require('../../../core/middleware/requireRole');
const requireModule = require('../../../core/middleware/requireModule');
const c = require('../controllers/revenueController');

router.use(requireAuth, requireRole('manager'), requireModule('expenses'));

router.get('/dashboard',          c.getDashboard);
router.put('/actual',             c.upsertActual);
router.put('/ticket-average',     c.updateTicketAverage);

module.exports = router;
