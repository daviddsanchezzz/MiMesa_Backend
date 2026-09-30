const router = require('express').Router();
const auth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const {
  getCustomers, getCustomerDetail, createCustomer, updateCustomer, deleteCustomer, exportCustomer, exportCustomersCsv,
} = require('../controllers/customerController');

router.use(auth);
router.get('/', getCustomers);
router.get('/export.csv', requireRole('owner'), exportCustomersCsv);
router.get('/:id', requireRole('manager'), getCustomerDetail);
router.get('/:id/export', requireRole('manager'), exportCustomer);
router.post('/', requireRole('manager'), createCustomer);
router.put('/:id', requireRole('manager'), updateCustomer);
router.delete('/:id', requireRole('manager'), deleteCustomer);

module.exports = router;
