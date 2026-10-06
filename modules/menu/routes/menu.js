const router = require('express').Router();
const requireAuth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const requireModule = require('../../../core/middleware/requireModule');
const c = require('../controllers/menuController');

router.use(requireAuth, requireModule('menu'));

// Anyone on the team sees the menu and can mark a dish as sold out; changing it is for managers
router.get('/', c.getMenu);
router.patch('/items/:id/sold-out', c.setSoldOut);

router.put('/settings', requireRole('manager'), c.saveSettings);
router.post('/categories', requireRole('manager'), c.createCategory);
router.put('/categories/order', requireRole('manager'), c.orderCategories);
router.put('/categories/:id', requireRole('manager'), c.updateCategory);
router.delete('/categories/:id', requireRole('manager'), c.deleteCategory);
router.post('/items', requireRole('manager'), c.createItem);
router.put('/items/order', requireRole('manager'), c.orderItems);
router.put('/items/:id', requireRole('manager'), c.updateItem);
router.delete('/items/:id', requireRole('manager'), c.deleteItem);
router.post('/import', requireRole('manager'), c.importItems);

module.exports = router;
