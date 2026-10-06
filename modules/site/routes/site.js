const router = require('express').Router();
const cors = require('cors');
const requireAuth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const requireModule = require('../../../core/middleware/requireModule');
const c = require('../controllers/siteController');
const pub = require('../controllers/publicSiteController');

// What the website reads (no session; rate-limited in app.js)
router.get('/public/:businessId', cors({ origin: '*' }), pub.publicSite);

router.use(requireAuth, requireModule('web'), requireRole('manager'));
router.get('/', c.getProfile);
router.put('/', c.saveProfile);

module.exports = router;
