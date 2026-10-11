const router = require('express').Router();
const requireAuth   = require('../../../core/middleware/requireAuth');
const requireRole   = require('../../../core/middleware/requireRole');
const requireModule = require('../../../core/middleware/requireModule');
const c = require('../controllers/categoryController');

router.use(requireAuth, requireRole('owner'), requireModule('expenses')); // same rule as the screen: Finanzas is for the owner

router.get('/',     c.getCategories);
router.post('/',    c.createCategory);
router.put('/:id',  c.updateCategory);
router.delete('/:id', c.deleteCategory);

module.exports = router;
