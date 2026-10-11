const router = require('express').Router();
const requireAuth   = require('../../../core/middleware/requireAuth');
const requireRole   = require('../../../core/middleware/requireRole');
const requireModule = require('../../../core/middleware/requireModule');
const c = require('../controllers/expenseController');

router.use(requireAuth, requireRole('owner'), requireModule('expenses')); // same rule as the screen: Finanzas is for the owner

router.get('/',               c.getExpenses);
router.post('/',              c.createExpense);
router.put('/:id',            c.updateExpense);
router.delete('/:id',         c.deleteExpense);

// Recurring templates
router.get('/templates',          c.getTemplates);
router.patch('/templates/:id',    c.updateTemplate);
router.delete('/templates/:id',   c.deleteTemplate);

module.exports = router;
