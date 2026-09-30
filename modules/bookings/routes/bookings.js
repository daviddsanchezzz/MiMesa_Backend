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
router.get('/:id', c.getBooking);
router.patch('/:id/status', c.setBookingStatus);
router.patch('/:id/notes', c.updateBookingNotes);

module.exports = router;
