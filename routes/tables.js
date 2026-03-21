const router = require('express').Router();
const auth = require('../middleware/requireAuth');
const { getTables, createTable, bulkCreateTables, updateTable, deleteTable } = require('../controllers/tableController');

router.use(auth);
router.get('/', getTables);
router.post('/bulk', bulkCreateTables);
router.post('/', createTable);
router.put('/:id', updateTable);
router.delete('/:id', deleteTable);

module.exports = router;
