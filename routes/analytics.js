const router = require('express').Router();
const auth = require('../middleware/requireAuth');
const { getOverview } = require('../controllers/analyticsController');

router.use(auth);
router.get('/overview', getOverview);

module.exports = router;
