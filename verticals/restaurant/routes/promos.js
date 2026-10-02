const router      = require('express').Router();
const auth        = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const requirePlan = require('../../../core/middleware/requirePlan');
const pc          = require('../controllers/promoController');

// Public — no auth needed
router.get('/public/:businessId/has-active', pc.hasActive);
router.post('/public/validate',              pc.validate);

// Authenticated — read is free, write requires Basic
router.use(auth, requireRole('manager'));
router.get('/',       pc.list);
router.post('/',      requirePlan('promoCodes'), pc.create);
router.put('/:id',    requirePlan('promoCodes'), pc.update);
router.delete('/:id', requirePlan('promoCodes'), pc.remove);

module.exports = router;
