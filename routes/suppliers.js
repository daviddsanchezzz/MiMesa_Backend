const router = require('express').Router();
const requireAuth   = require('../middleware/requireAuth');
const requireRole   = require('../middleware/requireRole');
const requireModule = require('../middleware/requireModule');
const c = require('../controllers/supplierController');

router.use(requireAuth, requireRole('manager'), requireModule('expenses'));

router.get('/',                  c.getSuppliers);
router.post('/',                 c.createSupplier);
router.put('/:id',               c.updateSupplier);
router.get('/:id/expenses',      c.getSupplierExpenses);

module.exports = router;
