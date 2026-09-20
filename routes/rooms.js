const router = require('express').Router();
const auth   = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { getRooms, createRoom, updateRoom, deleteRoom, getPublicRooms } = require('../controllers/roomController');

// Public route (before auth middleware)
router.get('/public/:businessId', getPublicRooms);

router.use(auth);
router.get('/',     getRooms);
router.post('/',    requireRole('manager'), createRoom);
router.put('/:id',  requireRole('manager'), updateRoom);
router.delete('/:id', requireRole('manager'), deleteRoom);

module.exports = router;
