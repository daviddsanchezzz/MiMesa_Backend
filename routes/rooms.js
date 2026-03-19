const router = require('express').Router();
const auth   = require('../middleware/requireAuth');
const { getRooms, createRoom, updateRoom, deleteRoom, getPublicRooms } = require('../controllers/roomController');

// Public route (before auth middleware)
router.get('/public/:businessId', getPublicRooms);

router.use(auth);
router.get('/',     getRooms);
router.post('/',    createRoom);
router.put('/:id',  updateRoom);
router.delete('/:id', deleteRoom);

module.exports = router;
