const router = require('express').Router();
const auth = require('../middleware/auth');
const { getReservations, createReservation, updateReservation, deleteReservation, createPublicReservation, cancelPublicReservation, getPublicReservationDetails } = require('../controllers/reservationController');

// Public routes (before auth middleware)
router.post('/public', createPublicReservation);
router.get('/public/details', getPublicReservationDetails);
router.get('/public/cancel', cancelPublicReservation);

router.use(auth);
router.get('/', getReservations);
router.post('/', createReservation);
router.put('/:id', updateReservation);
router.delete('/:id', deleteReservation);

module.exports = router;
