const router      = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const c           = require('../controllers/membersController');

// All routes require authentication
router.use(requireAuth);

// Any member can see the team list
router.get('/',              c.listMembers);

// Manager+ can add members (with role manager or staff)
router.post('/',             requireRole('manager'), c.addMember);

// Owner only: change roles and remove members
router.put('/:memberId',     requireRole('owner'), c.updateRole);
router.delete('/:memberId',  requireRole('owner'), c.removeMember);

module.exports = router;
