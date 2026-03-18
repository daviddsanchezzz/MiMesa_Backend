const router = require('express').Router();
const auth   = require('../middleware/auth');
const c      = require('../controllers/shiftController');

// Public routes (before auth middleware)
router.get('/public/slots', c.getPublicSlots);
router.get('/public/month-availability', c.getPublicMonthAvailability);

router.use(auth);
router.get('/slots', c.getSlots);   // must be before /:id
router.get('/',      c.getShifts);
router.post('/',     c.createShift);
router.put('/:id',   c.updateShift);
router.delete('/:id', c.deleteShift);

module.exports = router;
