const router = require('express').Router();
const auth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const { getTables, createTable, bulkCreateTables, updateTable, deleteTable } = require('../controllers/tableController');

router.use(auth);
router.get('/', getTables);
router.post('/bulk', requireRole('manager'), bulkCreateTables);
router.post('/', requireRole('manager'), createTable);
router.put('/:id', updateTable);
router.delete('/:id', requireRole('manager'), deleteTable);

module.exports = router;
