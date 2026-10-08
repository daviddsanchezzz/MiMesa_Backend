const router = require('express').Router();
const requireAuth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const requireAnyModule = require('../../../core/middleware/requireAnyModule');
const c = require('../controllers/recipeController');

router.use(requireAuth, requireRole('manager'), requireAnyModule(['expenses', 'purchases']));

router.get('/', c.list);
router.get('/by-ingredient/:id', c.byIngredient);
router.get('/:itemId', c.get);
router.put('/:itemId', c.save);
router.delete('/:itemId', c.remove);

module.exports = router;
