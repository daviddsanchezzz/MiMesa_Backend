const router = require('express').Router();
const auth = require('../middleware/auth');
const { getCustomers, createCustomer, updateCustomer } = require('../controllers/customerController');

router.use(auth);
router.get('/', getCustomers);
router.post('/', createCustomer);
router.put('/:id', updateCustomer);

module.exports = router;
