const { getSupabaseClient } = require('../../../core/config/supabase');
const {
  InvoiceStorageError, objectPath, safeSegment, validateObjectKey,
} = require('./invoiceStorageSupport');

const DEFAULT_BUCKET = 'vetra-invoices';
const LIST_PAGE_SIZE = 100;
const DELETE_BATCH_SIZE = 100;

class SupabaseInvoiceStorageProvider {
  constructor({ client, bucket } = {}) {
    this.kind = 'supabase';
    this.client = client;
    this.bucket = bucket || process.env.SUPABASE_INVOICES_BUCKET || DEFAULT_BUCKET;
  }

  storage() {
    return (this.client || getSupabaseClient()).storage.from(this.bucket);
  }

  async store({ businessId, invoiceId, mimeType, buffer }) {
    const key = objectPath({ businessId, invoiceId, mimeType });
    const { error } = await this.storage().upload(key, buffer, { contentType: mimeType, upsert: false });
    if (error) throw new InvoiceStorageError('No se pudo subir el documento', 'DOCUMENT_UPLOAD_FAILED', error);
    return key;
  }

  async access(key, { expiresIn = 60 } = {}) {
    const normalizedKey = validateObjectKey(key);
    const { data, error } = await this.storage().createSignedUrl(normalizedKey, expiresIn);
    if (error || !data?.signedUrl) {
      if (Number(error?.statusCode || error?.status) === 404) {
        throw new InvoiceStorageError('Documento no encontrado', 'DOCUMENT_NOT_FOUND', error);
      }
      throw new InvoiceStorageError('No se pudo crear el acceso temporal', 'SIGNED_URL_FAILED', error);
    }
    return { type: 'redirect', url: data.signedUrl, expiresIn };
  }

  async remove(key) {
    if (!key) return;
    const normalizedKey = validateObjectKey(key);
    const { error } = await this.storage().remove([normalizedKey]);
    if (error) throw new InvoiceStorageError('No se pudo eliminar el documento', 'DOCUMENT_DELETE_FAILED', error);
  }

  async listPage(prefix, offset) {
    const { data, error } = await this.storage().list(prefix, {
      limit: LIST_PAGE_SIZE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new InvoiceStorageError('No se pudo listar el almacenamiento del negocio', 'DOCUMENT_LIST_FAILED', error);
    return data || [];
  }

  async collectFiles(prefix, output) {
    let offset = 0;
    while (true) {
      const entries = await this.listPage(prefix, offset);
      for (const entry of entries) {
        const child = `${prefix}/${entry.name}`;
        if (entry.id || entry.metadata) output.push(child);
        else await this.collectFiles(child, output);
      }
      if (entries.length < LIST_PAGE_SIZE) break;
      offset += entries.length;
    }
  }

  async removeBusiness(businessId) {
    const prefix = safeSegment(businessId, 'businessId');
    const files = [];
    await this.collectFiles(prefix, files);
    for (let index = 0; index < files.length; index += DELETE_BATCH_SIZE) {
      const { error } = await this.storage().remove(files.slice(index, index + DELETE_BATCH_SIZE));
      if (error) throw new InvoiceStorageError('No se pudo purgar el almacenamiento del negocio', 'BUSINESS_DOCUMENT_DELETE_FAILED', error);
    }
    return files.length;
  }
}

module.exports = { SupabaseInvoiceStorageProvider, DEFAULT_BUCKET, LIST_PAGE_SIZE };
