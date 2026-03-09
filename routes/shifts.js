const router = require('express').Router();
const auth   = require('../middleware/auth');
const c      = require('../controllers/shiftController');

// Public route (before auth middleware)
router.get('/public/slots', c.getPublicSlots);

router.use(auth);
router.get('/slots', c.getSlots);   // must be before /:id
router.get('/',      c.getShifts);
router.post('/',     c.createShift);
router.put('/:id',   c.updateShift);
router.delete('/:id', c.deleteShift);

module.exports = router;
