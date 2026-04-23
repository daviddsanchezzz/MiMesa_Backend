const router = require('express').Router();
const auth = require('../middleware/requireAuth');
const { getCustomers, getCustomerDetail, createCustomer, updateCustomer } = require('../controllers/customerController');

router.use(auth);
router.get('/', getCustomers);
router.get('/:id', getCustomerDetail);
router.post('/', createCustomer);
router.put('/:id', updateCustomer);

module.exports = router;
