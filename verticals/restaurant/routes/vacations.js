const router = require('express').Router();
const auth   = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const c      = require('../controllers/vacationController');

// Public route (before auth middleware)
router.get('/public/check', c.checkPublicDate);

router.use(auth);
router.get('/check', c.checkDate);   // must be before /:id
router.get('/',      c.getVacations);
router.post('/',     requireRole('manager'), c.createVacation);
router.delete('/:id', requireRole('manager'), c.deleteVacation);

module.exports = router;
