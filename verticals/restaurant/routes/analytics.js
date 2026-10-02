const router = require('express').Router();
const auth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const { getOverview } = require('../controllers/analyticsController');

router.use(auth, requireRole('manager'));
router.get('/overview', getOverview);

module.exports = router;
