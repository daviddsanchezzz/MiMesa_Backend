const fs = require('node:fs');
const path = require('node:path');
const {
  InvoiceStorageError, objectPath, safeSegment, validateObjectKey,
} = require('./invoiceStorageSupport');

class LocalInvoiceStorageProvider {
  constructor({ root } = {}) {
    this.kind = 'local';
    this.root = path.resolve(root || process.env.INVOICE_STORAGE_DIR || path.join(__dirname, '..', '..', '..', 'storage', 'invoices'));
  }

  resolveKey(key) {
    const normalizedKey = validateObjectKey(key);
    const target = path.resolve(this.root, ...normalizedKey.split('/'));
    const relative = path.relative(this.root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new InvoiceStorageError('Clave de documento no valida', 'INVALID_STORAGE_PATH');
    }
    return target;
  }

  async store({ businessId, invoiceId, mimeType, buffer }) {
    const key = objectPath({ businessId, invoiceId, mimeType });
    const target = this.resolveKey(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
    return key;
  }

  async access(key) {
    const target = this.resolveKey(key);
    try {
      const stat = await fs.promises.stat(target);
      if (!stat.isFile()) throw new Error('not a file');
      return { type: 'stream', stream: fs.createReadStream(target), size: stat.size };
    } catch (error) {
      throw new InvoiceStorageError('Documento local no encontrado', 'DOCUMENT_NOT_FOUND', error);
    }
  }

  async remove(key) {
    if (!key) return;
    try {
      await fs.promises.unlink(this.resolveKey(key));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new InvoiceStorageError('No se pudo eliminar el documento local', 'DOCUMENT_DELETE_FAILED', error);
    }
  }

  async removeBusiness(businessId) {
    const businessDirectory = path.resolve(this.root, safeSegment(businessId, 'businessId'));
    const relative = path.relative(this.root, businessDirectory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new InvoiceStorageError('Prefijo de negocio no valido', 'INVALID_STORAGE_PATH');
    }
    await fs.promises.rm(businessDirectory, { recursive: true, force: true });
  }
}

module.exports = { LocalInvoiceStorageProvider };
