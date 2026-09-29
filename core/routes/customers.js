const router = require('express').Router();
const auth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { getCustomers, getCustomerDetail, createCustomer, updateCustomer, deleteCustomer } = require('../controllers/customerController');

router.use(auth);
router.get('/', getCustomers);
router.get('/:id', requireRole('manager'), getCustomerDetail);
router.post('/', requireRole('manager'), createCustomer);
router.put('/:id', requireRole('manager'), updateCustomer);
router.delete('/:id', requireRole('manager'), deleteCustomer);

module.exports = router;
