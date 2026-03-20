const router         = require('express').Router();
const requireSession = require('../middleware/requireSession');
const { createBusiness, deleteBusiness } = require('../controllers/businessesController');

router.post('/', requireSession, createBusiness);
router.delete('/:id', requireSession, deleteBusiness);

module.exports = router;
