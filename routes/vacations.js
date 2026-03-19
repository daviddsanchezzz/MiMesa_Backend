const router = require('express').Router();
const auth   = require('../middleware/requireAuth');
const c      = require('../controllers/vacationController');

// Public route (before auth middleware)
router.get('/public/check', c.checkPublicDate);

router.use(auth);
router.get('/check', c.checkDate);   // must be before /:id
router.get('/',      c.getVacations);
router.post('/',     c.createVacation);
router.delete('/:id', c.deleteVacation);

module.exports = router;
