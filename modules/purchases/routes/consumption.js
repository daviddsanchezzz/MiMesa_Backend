const router = require('express').Router();
const requireAuth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const requireAnyModule = require('../../../core/middleware/requireAnyModule');
const c = require('../controllers/consumptionController');

router.use(requireAuth, requireRole('manager'), requireAnyModule(['expenses', 'purchases']));

router.post('/sales/import', c.importSales);
router.get('/report', c.report);
router.get('/stock', c.stock);
router.post('/stock', c.saveStock);
router.get('/waste', c.listWaste);
router.post('/waste', c.addWaste);
router.delete('/waste/:id', c.removeWaste);

module.exports = router;
