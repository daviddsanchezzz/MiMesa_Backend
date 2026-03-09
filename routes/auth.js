const router = require('express').Router();
const { register, login, me, getPublicBusiness, updateBusinessSettings } = require('../controllers/authController');
const auth = require('../middleware/auth');

router.post('/register', register);
router.post('/login', login);
router.get('/me', auth, me);
router.put('/settings', auth, updateBusinessSettings);

// Public route
router.get('/public/business/:id', getPublicBusiness);

module.exports = router;
