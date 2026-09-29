const router = require('express').Router();
const { submit } = require('../controllers/contactController');

router.post('/', submit);

module.exports = router;
