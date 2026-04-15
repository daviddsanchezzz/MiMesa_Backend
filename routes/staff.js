const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const requireModule = require('../middleware/requireModule');
const c = require('../controllers/staffController');

router.use(requireAuth, requireRole('manager'), requireModule('staff'));

router.get('/positions', c.getPositions);
router.post('/positions', c.createPosition);
router.put('/positions/:id', c.updatePosition);
router.patch('/positions/:id/status', c.setPositionStatus);

router.get('/employees', c.getEmployees);
router.post('/employees', c.createEmployee);
router.put('/employees/:id', c.updateEmployee);
router.patch('/employees/:id/status', c.setEmployeeStatus);

router.get('/employees/:id/compensations', c.getEmployeeCompensations);
router.post('/employees/:id/compensations', c.createEmployeeCompensation);

router.get('/assignments', c.getAssignments);
router.post('/assignments', c.createAssignment);
router.put('/assignments/:id', c.updateAssignment);
router.delete('/assignments/:id', c.deleteAssignment);

router.get('/costs', c.getWeeklyCosts);

module.exports = router;
