const router         = require('express').Router();
const requireSession = require('../middleware/requireSession');
const { createBusiness } = require('../controllers/businessesController');

router.post('/', requireSession, createBusiness);

module.exports = router;
