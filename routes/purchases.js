const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const requireModule = require('../middleware/requireModule');
const c = require('../controllers/purchaseController');

router.use(requireAuth, requireRole('manager'), requireModule('purchases'));

router.get('/products', c.listProducts);
router.post('/products', c.createProduct);
router.put('/products/:id', c.updateProduct);

router.get('/orders', c.listOrders);
router.post('/orders', c.createOrder);
router.put('/orders/:id', c.updateOrder);

module.exports = router;

