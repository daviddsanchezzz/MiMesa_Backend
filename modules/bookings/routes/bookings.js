const router = require('express').Router();
const cors = require('cors');
const requireAuth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const requireModule = require('../../../core/middleware/requireModule');
const c = require('../controllers/bookingsController');

// Public booking page (guests, no session). Rate-limited in app.js.
const publicCors = cors({ origin: '*' });
router.get('/public/cancel', publicCors, c.publicBookingDetails);
router.post('/public/cancel', publicCors, c.publicCancelBooking);
router.get('/public/:businessId/catalog', publicCors, c.publicCatalog);
router.get('/public/:businessId/availability', publicCors, c.publicAvailability);
router.post('/public/:businessId/bookings', publicCors, c.publicCreateBooking);

router.use(requireAuth, requireModule('bookings'));

// Setup: resources, services and schedules (manager+)
router.get('/resources', c.listResources);
router.post('/resources', requireRole('manager'), c.createResource);
router.put('/resources/:id', requireRole('manager'), c.updateResource);
router.put('/resources/:id/services', requireRole('manager'), c.setResourceServices);
router.delete('/resources/:id', requireRole('manager'), c.deleteResource);

router.get('/services', c.listServices);
router.post('/services', requireRole('manager'), c.createService);
router.put('/services/:id', requireRole('manager'), c.updateService);
router.delete('/services/:id', requireRole('manager'), c.deleteService);

router.get('/schedule', c.getSchedule);
router.put('/schedule', requireRole('manager'), c.putSchedule);
router.delete('/schedule', requireRole('manager'), c.deleteSchedule);

// Dashboard numbers (any member)
router.get('/stats', c.getStats);

// Customer history (manager+, like the customer list)
router.get('/customers/summary', requireRole('manager'), c.customersSummary);
router.get('/customers/:customerId', requireRole('manager'), c.customerBookings);

// Day-to-day: any member can see the agenda and book
router.get('/availability', c.getAvailability);
router.get('/', c.listBookings);
router.post('/', c.createBooking);
// Team pay and results (managers, with the staff module)
router.get('/team', requireRole('manager'), requireModule('staff'), c.teamReport);
router.put('/team/:resourceId/pay', requireRole('manager'), requireModule('staff'), c.setTeamPay);
router.post('/team/:resourceId/payments', requireRole('manager'), requireModule('staff'), c.addTeamPayment);

// Caja (any member charges and closes; managers undo and reopen)
router.get('/cash', c.cashDay);
router.post('/cash/close', c.closeCash);
router.delete('/cash/close', requireRole('manager'), c.reopenCash);
// Follow-up emails to customers (managers)
router.get('/follow-ups', requireRole('manager'), c.getFollowUps);
router.put('/follow-ups', requireRole('manager'), c.saveFollowUps);

// Absences: anyone blocks their own agenda; managers anybody's (checked inside)
router.get('/absences', c.listAbsences);
router.post('/absences', c.createAbsence);
router.delete('/absences/:id', c.deleteAbsence);
router.get('/:id', c.getBooking);
router.get('/:id/reassign-options', c.reassignOptions);
router.patch('/:id/reassign', c.reassignBooking);
router.post('/:id/checkout', c.checkout);
router.delete('/:id/checkout', requireRole('manager'), c.undoCheckout);
router.patch('/:id/status', c.setBookingStatus);
router.patch('/:id/notes', c.updateBookingNotes);

module.exports = router;
