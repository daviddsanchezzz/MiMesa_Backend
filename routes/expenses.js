const router = require('express').Router();
const requireAuth   = require('../middleware/requireAuth');
const requireRole   = require('../middleware/requireRole');
const requireModule = require('../middleware/requireModule');
const c = require('../controllers/expenseController');

router.use(requireAuth, requireRole('manager'), requireModule('expenses'));

router.get('/',      c.getExpenses);
router.post('/',     c.createExpense);
router.put('/:id',   c.updateExpense);
router.delete('/:id', c.deleteExpense);

module.exports = router;
