const router         = require('express').Router();
const requireSession = require('../middleware/requireSession');
const { createBusiness, deleteBusiness, listTemplates } = require('../controllers/businessesController');

router.get('/templates', requireSession, listTemplates);
router.post('/', requireSession, createBusiness);
router.delete('/:id', requireSession, deleteBusiness);

module.exports = router;
