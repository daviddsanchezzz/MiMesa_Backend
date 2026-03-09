const router = require('express').Router();
const auth = require('../middleware/auth');
const { getTables, createTable, updateTable, deleteTable } = require('../controllers/tableController');

router.use(auth);
router.get('/', getTables);
router.post('/', createTable);
router.put('/:id', updateTable);
router.delete('/:id', deleteTable);

module.exports = router;
