const router = require('express').Router();
const auth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const c = require('../controllers/exceptionController');

// Public route
router.get('/public/check', c.checkPublicExceptions);

router.use(auth);
router.get('/', requireRole('manager'), c.getExceptions);
router.post('/', requireRole('manager'), c.createException);
router.put('/:id', requireRole('manager'), c.updateException);
router.delete('/:id', requireRole('manager'), c.deleteException);

module.exports = router;

