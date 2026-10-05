const router = require('express').Router();
const requireAuth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const requireModule = require('../../../core/middleware/requireModule');
const c = require('../controllers/staffController');
const schedule = require('../controllers/staffScheduleController');
const timeOff = require('../controllers/staffTimeOffController');
const swaps = require('../controllers/staffSwapController');

router.get('/public/professionals', c.getPublicProfessionals);
// Anyone who is linked to an employee can see their own shifts; everything else is the manager's
router.get('/me/schedule', requireAuth, requireModule('staff'), c.mySchedule);
router.get('/me/time-off', requireAuth, requireModule('staff'), timeOff.mine);
router.post('/me/time-off', requireAuth, requireModule('staff'), timeOff.request);
router.delete('/me/time-off/:id', requireAuth, requireModule('staff'), timeOff.cancelMine);
router.get('/me/swaps', requireAuth, requireModule('staff'), swaps.mine);
router.get('/me/swaps/colleagues', requireAuth, requireModule('staff'), swaps.colleagues);
router.post('/me/swaps', requireAuth, requireModule('staff'), swaps.request);
router.post('/me/swaps/:id/accept', requireAuth, requireModule('staff'), swaps.accept);
router.post('/me/swaps/:id/decline', requireAuth, requireModule('staff'), swaps.decline);
router.delete('/me/swaps/:id', requireAuth, requireModule('staff'), swaps.cancel);

router.use(requireAuth, requireRole('manager'), requireModule('staff'));

router.get('/positions', c.getPositions);
router.post('/positions', c.createPosition);
router.patch('/positions/reorder', c.reorderPositions);
router.put('/positions/:id', c.updatePosition);
router.patch('/positions/:id/status', c.setPositionStatus);

router.get('/employees', c.getEmployees);
router.post('/employees', c.createEmployee);
router.put('/employees/:id', c.updateEmployee);
router.patch('/employees/:id/status', c.setEmployeeStatus);
router.delete('/employees/:id/access', requireRole('owner'), c.revokeEmployeeAccess);
router.put('/employees/:id/link', c.linkEmployeeMember);
router.delete('/employees/:id/link', c.unlinkEmployeeMember);

router.get('/employees/:id/compensations', c.getEmployeeCompensations);
router.post('/employees/:id/compensations', c.createEmployeeCompensation);
router.get('/employees/:id/assignments', c.getEmployeeAssignments);

router.get('/assignments', c.getAssignments);
router.post('/assignments', c.createAssignment);
router.put('/assignments/:id', c.updateAssignment);
router.delete('/assignments/:id', c.deleteAssignment);

router.get('/schedule/status', schedule.status);
router.post('/schedule/publish', schedule.publish);
router.delete('/schedule/publish', schedule.unpublish);

router.get('/time-off', timeOff.list);
router.post('/time-off', timeOff.create);
router.patch('/time-off/:id/decision', timeOff.decide);
router.delete('/time-off/:id', timeOff.remove);

router.get('/swaps', swaps.list);
router.patch('/swaps/:id/decision', swaps.decide);

router.get('/costs', c.getWeeklyCosts);
router.get('/costs/monthly', c.getMonthlyCosts);
router.get('/performance', c.getPerformance);
router.get('/balances', c.getBalances);
router.post('/payments', c.createPayment);

module.exports = router;
