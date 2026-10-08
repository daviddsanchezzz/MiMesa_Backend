const router = require('express').Router();
const requireAuth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const requireAnyModule = require('../../../core/middleware/requireAnyModule');
const c = require('../controllers/ingredientController');

// Same door as the invoices they come from
router.use(requireAuth, requireRole('manager'), requireAnyModule(['expenses', 'purchases']));

router.get('/', c.list);
router.get('/inbox', c.inbox);
router.get('/alerts', c.alerts);
router.get('/settings', c.getSettings);
router.put('/settings', c.saveSettings);
router.post('/link', c.link);
router.post('/', c.create);
router.get('/:id', c.get);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
