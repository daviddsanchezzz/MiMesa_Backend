const router = require('express').Router();
const auth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const requirePlan = require('../middleware/requirePlan');
const {
  getReservations,
  getPendingReservations,
  createReservation,
  updateReservation,
  deleteReservation,
  createPublicReservation,
  cancelPublicReservation,
  getPublicReservationDetails,
  acceptPendingReservation,
  rejectPendingReservation,
  proposeAlternativeTime,
  markNoShow,
} = require('../controllers/reservationController');
const {
  getPublicPaymentConfig,
  createPublicPaymentIntent,
  createReservationPaymentIntent,
  refundDeposit,
} = require('../controllers/reservationPaymentController');

// Public routes (before auth middleware)
router.post('/public', createPublicReservation);
router.get('/public/details', getPublicReservationDetails);
router.get('/public/cancel', cancelPublicReservation);
router.get('/public/payment-config', getPublicPaymentConfig);
router.post('/public/payment-intent', createPublicPaymentIntent);
router.post('/:id/create-payment-intent', createReservationPaymentIntent);

router.use(auth);
router.get('/', getReservations);
router.get('/pending', requireRole('manager'), getPendingReservations);
router.post('/', createReservation);
router.put('/:id/accept', requireRole('manager'), acceptPendingReservation);
router.put('/:id/reject', requireRole('manager'), rejectPendingReservation);
router.put('/:id/propose-alternative', requireRole('manager'), proposeAlternativeTime);
router.put('/:id/no-show', requireRole('manager'), markNoShow);
router.post('/:id/refund',        requireRole('manager'), requirePlan('reservationPayments'), refundDeposit);
router.put('/:id', updateReservation);
router.delete('/:id', deleteReservation);

module.exports = router;
