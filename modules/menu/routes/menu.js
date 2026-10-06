const multer = require('multer');
const router = require('express').Router();
const cors = require('cors');
const requireAuth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const requireModule = require('../../../core/middleware/requireModule');
const c = require('../controllers/menuController');
const pub = require('../controllers/publicMenuController');
const { MAX_BYTES } = require('../services/photoStorage');

// The menu as the website shows it (no session; rate-limited in app.js)
const publicCors = cors({ origin: '*' });
router.get('/public/photos/:businessId/:file', publicCors, pub.publicPhoto);
router.get('/public/:businessId', publicCors, pub.publicMenu);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
function uploadPhoto(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'La foto es demasiado grande (máximo 2 MB)' });
    return res.status(400).json({ message: 'Foto no válida' });
  });
}

router.use(requireAuth, requireModule('menu'));

// Anyone on the team sees the menu and can mark a dish as sold out; changing it is for managers
router.get('/', c.getMenu);
router.patch('/items/:id/sold-out', c.setSoldOut);

router.put('/settings', requireRole('manager'), c.saveSettings);
router.put('/daily', requireRole('manager'), c.saveDaily);
router.post('/categories', requireRole('manager'), c.createCategory);
router.put('/categories/order', requireRole('manager'), c.orderCategories);
router.put('/categories/:id', requireRole('manager'), c.updateCategory);
router.delete('/categories/:id', requireRole('manager'), c.deleteCategory);
router.post('/items', requireRole('manager'), c.createItem);
router.put('/items/order', requireRole('manager'), c.orderItems);
router.put('/items/:id', requireRole('manager'), c.updateItem);
router.post('/items/:id/photo', requireRole('manager'), uploadPhoto, c.uploadPhoto);
router.delete('/items/:id/photo', requireRole('manager'), c.deletePhoto);
router.delete('/items/:id', requireRole('manager'), c.deleteItem);
router.post('/import', requireRole('manager'), c.importItems);
router.post('/translate', requireRole('manager'), c.translateTexts);
router.get('/translate-missing', requireRole('manager'), c.countMissing);
router.post('/translate-missing', requireRole('manager'), c.translateMissing);

module.exports = router;
