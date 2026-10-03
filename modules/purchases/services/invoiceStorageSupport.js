const path = require('node:path');

const MIME_EXTENSIONS = Object.freeze({
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
});

class InvoiceStorageError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'InvoiceStorageError';
    this.code = code;
    // Keep only non-sensitive provider metadata. Never retain request URLs,
    // credentials, response bodies, or document contents on the public error.
    if (cause?.code && typeof cause.code !== 'object') this.providerCode = String(cause.code);
    if (Number.isInteger(cause?.statusCode || cause?.status)) this.providerStatus = cause.statusCode || cause.status;
  }
}

function safeSegment(value, label) {
  const segment = String(value || '');
  if (!segment || !/^[a-zA-Z0-9_-]+$/.test(segment)) {
    throw new InvoiceStorageError(`${label} no valido`, 'INVALID_STORAGE_PATH');
  }
  return segment;
}

function objectPath({ businessId, invoiceId, mimeType }) {
  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) throw new InvoiceStorageError('Tipo de documento no permitido', 'INVALID_MIME_TYPE');
  return `${safeSegment(businessId, 'businessId')}/${safeSegment(invoiceId, 'invoiceId')}/original${extension}`;
}

function validateObjectKey(key) {
  const value = String(key || '');
  if (!value || value.includes('\\') || path.posix.normalize(value) !== value || value.startsWith('/') || value.includes('../')) {
    throw new InvoiceStorageError('Clave de documento no valida', 'INVALID_STORAGE_PATH');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[a-zA-Z0-9_.-]+$/.test(segment))) {
    throw new InvoiceStorageError('Clave de documento no valida', 'INVALID_STORAGE_PATH');
  }
  return value;
}

module.exports = { MIME_EXTENSIONS, InvoiceStorageError, objectPath, safeSegment, validateObjectKey };
