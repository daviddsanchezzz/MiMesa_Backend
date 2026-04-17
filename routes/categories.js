const router = require('express').Router();
const requireAuth   = require('../middleware/requireAuth');
const requireRole   = require('../middleware/requireRole');
const requireModule = require('../middleware/requireModule');
const c = require('../controllers/categoryController');

router.use(requireAuth, requireRole('manager'), requireModule('expenses'));

router.get('/',     c.getCategories);
router.post('/',    c.createCategory);
router.put('/:id',  c.updateCategory);
router.delete('/:id', c.deleteCategory);

module.exports = router;
