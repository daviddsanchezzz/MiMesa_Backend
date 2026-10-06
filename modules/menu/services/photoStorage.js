/**
 * Photos of dishes. Unlike the invoices (private, signed links), these are shown to anyone on the
 * restaurant's website, so they live in a PUBLIC bucket (SUPABASE_MENU_BUCKET, default `vetra-menu`)
 * and the dish keeps the public URL. Local disk is used outside production.
 *
 * Keys are `businessId/itemId-random.ext`: a new random part per upload, so a replaced photo is a new URL
 * and no cache keeps showing the old one.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getSupabaseClient } = require('../../../core/config/supabase');

const DEFAULT_BUCKET = 'vetra-menu';
const MAX_BYTES = 2 * 1024 * 1024;

class PhotoError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** The real type from the first bytes (the declared one can lie). */
function detectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

const SEGMENT = /^[a-zA-Z0-9_-]+$/;
const KEY = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/;

function makeKey(businessId, itemId, ext) {
  if (!SEGMENT.test(String(businessId)) || !SEGMENT.test(String(itemId))) throw new PhotoError('Identificador no válido');
  return `${businessId}/${itemId}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
}

class SupabasePhotos {
  constructor() { this.kind = 'supabase'; this.bucket = process.env.SUPABASE_MENU_BUCKET || DEFAULT_BUCKET; }

  bucketApi() { return getSupabaseClient().storage.from(this.bucket); }

  async store({ key, buffer, mime }) {
    const { error } = await this.bucketApi().upload(key, buffer, { contentType: mime, upsert: false, cacheControl: '31536000' });
    if (error) throw new PhotoError('No se pudo subir la foto', 502);
    return this.bucketApi().getPublicUrl(key).data.publicUrl;
  }

  async remove(key) {
    if (!key) return;
    const { error } = await this.bucketApi().remove([key]);
    if (error) throw new PhotoError('No se pudo borrar la foto', 502);
  }

  async removeBusiness(businessId) {
    const prefix = String(businessId);
    if (!SEGMENT.test(prefix)) throw new PhotoError('Identificador no válido');
    let removed = 0;
    for (;;) {
      const { data, error } = await this.bucketApi().list(prefix, { limit: 100 });
      if (error) throw new PhotoError('No se pudo listar las fotos', 502);
      if (!data?.length) break;
      const { error: rmError } = await this.bucketApi().remove(data.map((f) => `${prefix}/${f.name}`));
      if (rmError) throw new PhotoError('No se pudo borrar las fotos', 502);
      removed += data.length;
      if (data.length < 100) break;
    }
    return removed;
  }
}

class LocalPhotos {
  constructor() {
    this.kind = 'local';
    this.root = path.resolve(process.env.MENU_STORAGE_DIR || path.join(__dirname, '..', '..', '..', 'storage', 'menu'));
  }

  resolve(key) {
    if (!KEY.test(String(key))) throw new PhotoError('Clave no válida');
    const target = path.resolve(this.root, ...key.split('/'));
    if (path.relative(this.root, target).startsWith('..')) throw new PhotoError('Clave no válida');
    return target;
  }

  async store({ key, buffer }) {
    const target = this.resolve(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, buffer, { flag: 'wx' });
    const base = String(process.env.BACKEND_URL || '').replace(/\/$/, '');
    return `${base}/api/menu/public/photos/${key}`;
  }

  async remove(key) {
    if (!key) return;
    try { await fs.promises.unlink(this.resolve(key)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }

  async removeBusiness(businessId) {
    if (!SEGMENT.test(String(businessId))) throw new PhotoError('Identificador no válido');
    await fs.promises.rm(path.resolve(this.root, String(businessId)), { recursive: true, force: true });
    return 0;
  }

  /** For the public route in development. */
  async open(key) {
    const target = this.resolve(key);
    const stat = await fs.promises.stat(target).catch(() => null);
    if (!stat?.isFile()) return null;
    return { stream: fs.createReadStream(target), ext: path.extname(target).slice(1) };
  }
}

let provider;
function current() {
  if (!provider) {
    const fallback = process.env.NODE_ENV === 'production' ? 'supabase' : 'local';
    provider = String(process.env.MENU_STORAGE_PROVIDER || fallback).toLowerCase() === 'supabase' ? new SupabasePhotos() : new LocalPhotos();
  }
  return provider;
}

module.exports = {
  PhotoError, MAX_BYTES, detectImage, makeKey,
  store: (opts) => current().store(opts),
  remove: (key) => current().remove(key),
  removeBusiness: (businessId) => current().removeBusiness(businessId),
  open: (key) => (current().open ? current().open(key) : null),
  setProviderForTests(p) { provider = p; },
};
