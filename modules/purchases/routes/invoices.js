const multer = require('multer');
const router = require('express').Router();
const requireAuth = require('../../../core/middleware/requireAuth');
const requireRole = require('../../../core/middleware/requireRole');
const requireAnyModule = require('../../../core/middleware/requireAnyModule');
const controller = require('../controllers/invoiceController');
const { MIME_EXTENSIONS } = require('../services/invoiceStorage');

const maxFileSize = Number(process.env.INVOICE_MAX_FILE_SIZE || 10 * 1024 * 1024);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSize, files: 1 },
  fileFilter(req, file, callback) {
    if (!MIME_EXTENSIONS[file.mimetype]) return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
    return callback(null, true);
  },
});

function uploadInvoice(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: `La factura supera el limite de ${maxFileSize} bytes` });
    return res.status(400).json({ message: 'Archivo no valido. Usa PDF, JPEG, PNG o WebP' });
  });
}

router.use(requireAuth, requireRole('manager'), requireAnyModule(['expenses', 'purchases']));

router.post('/extract', uploadInvoice, controller.extractInvoice);
router.get('/', controller.listInvoices);
router.get('/:id/document', controller.downloadDocument);
router.get('/:id', controller.getInvoice);
router.patch('/:id', controller.patchInvoice);
router.post('/:id/confirm', controller.confirmInvoice);
router.delete('/:id', controller.deleteInvoice);

module.exports = router;
