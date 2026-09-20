const router = require('express').Router();
const auth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { getOverview } = require('../controllers/analyticsController');

router.use(auth, requireRole('manager'));
router.get('/overview', getOverview);

module.exports = router;
