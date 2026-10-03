const fs = require('node:fs');
const path = require('node:path');

const MIME_EXTENSIONS = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

function rootDirectory() {
  return path.resolve(process.env.INVOICE_STORAGE_DIR || path.join(__dirname, '..', '..', '..', 'storage', 'invoices'));
}

function resolveKey(key) {
  const root = rootDirectory();
  const target = path.resolve(root, String(key || ''));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Clave de documento no valida');
  return target;
}

async function store({ businessId, invoiceId, mimeType, buffer }) {
  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) throw new Error('Tipo de documento no permitido');
  const key = path.join(String(businessId), `${invoiceId}${extension}`);
  const target = resolveKey(key);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
  return key.split(path.sep).join('/');
}

async function open(key) {
  const target = resolveKey(key);
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) throw new Error('Documento no encontrado');
  return { stream: fs.createReadStream(target), size: stat.size };
}

async function remove(key) {
  if (!key) return;
  try {
    await fs.promises.unlink(resolveKey(key));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { MIME_EXTENSIONS, store, open, remove, rootDirectory };
