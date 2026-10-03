const router = require('express').Router();
const requireAuth   = require('../../../core/middleware/requireAuth');
const requireRole   = require('../../../core/middleware/requireRole');
const requireAnyModule = require('../../../core/middleware/requireAnyModule');
const c = require('../controllers/supplierController');

router.use(requireAuth, requireRole('manager'), requireAnyModule(['expenses', 'purchases']));

router.get('/',                  c.getSuppliers);
router.post('/',                 c.createSupplier);
router.put('/:id',               c.updateSupplier);
router.get('/:id/expenses',      c.getSupplierExpenses);
router.get('/:id',               c.getSupplierDetail);

module.exports = router;

