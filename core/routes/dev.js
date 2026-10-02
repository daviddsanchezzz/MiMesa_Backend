const router         = require('express').Router();
const requireSession = require('../middleware/requireSession');
const requireDev     = require('../middleware/requireDev');
const c              = require('../controllers/devController');

// All dev routes require a valid session AND dev email
router.use(requireSession, requireDev);

router.get('/overview',              c.overview);
router.get('/businesses',            c.listBusinesses);
router.get('/modules/catalog',       c.getModuleCatalog);
router.get('/users',                 c.listUsers);
router.post('/users/:id/impersonate', c.impersonateUser);
router.delete('/users/:id',           c.deleteUser);
router.post('/businesses',           c.createBusiness);
router.get('/templates',             c.listTemplates);
router.post('/clients',              c.createClient);
router.post('/businesses/:id/resend-owner-invite', c.resendOwnerInvitation);
router.patch('/businesses/:id/plan', c.updatePlan);
router.patch('/businesses/:id/modules/:moduleKey', c.updateBusinessModule);
router.delete('/businesses/:id',     c.deleteBusiness);
router.post('/migrate-memberships',  c.migrateMemberships);
router.post('/invite-user',          c.inviteUser);

module.exports = router;
