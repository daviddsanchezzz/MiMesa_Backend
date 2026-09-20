const router = require('express').Router();
const auth   = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const c      = require('../controllers/shiftController');

// Public routes (before auth middleware)
router.get('/public/slots', c.getPublicSlots);
router.get('/public/month-availability', c.getPublicMonthAvailability);

router.use(auth);
router.get('/slots', c.getSlots);   // must be before /:id
router.get('/',      c.getShifts);
router.post('/',     requireRole('manager'), c.createShift);
router.put('/:id',   requireRole('manager'), c.updateShift);
router.delete('/:id', requireRole('manager'), c.deleteShift);

module.exports = router;
