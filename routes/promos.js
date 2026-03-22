const router = require('express').Router();
const auth   = require('../middleware/requireAuth');
const pc     = require('../controllers/promoController');

// Public
router.get('/public/:businessId/has-active', pc.hasActive);
router.post('/public/validate',              pc.validate);

// Authenticated
router.use(auth);
router.get('/',       pc.list);
router.post('/',      pc.create);
router.put('/:id',    pc.update);
router.delete('/:id', pc.remove);

module.exports = router;
