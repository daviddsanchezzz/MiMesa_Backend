const { LocalInvoiceStorageProvider } = require('./localInvoiceStorage');
const { SupabaseInvoiceStorageProvider } = require('./supabaseInvoiceStorage');
const { MIME_EXTENSIONS, InvoiceStorageError } = require('./invoiceStorageSupport');

let provider;

function configuredProvider() {
  const fallback = process.env.NODE_ENV === 'production' ? 'supabase' : 'local';
  const name = String(process.env.INVOICE_STORAGE_PROVIDER || fallback).toLowerCase();
  if (name === 'local') return new LocalInvoiceStorageProvider();
  if (name === 'supabase') return new SupabaseInvoiceStorageProvider();
  throw new InvoiceStorageError('Proveedor de documentos no valido', 'INVALID_STORAGE_PROVIDER');
}

function current() {
  if (!provider) provider = configuredProvider();
  return provider;
}

const invoiceStorage = {
  MIME_EXTENSIONS,
  store: (options) => current().store(options),
  access: (key, options) => current().access(key, options),
  remove: (key) => current().remove(key),
  removeBusiness: (businessId) => current().removeBusiness(businessId),
  providerKind: () => current().kind,
  setProviderForTests(value) { provider = value; },
  resetProviderForTests() { provider = undefined; },
};

module.exports = invoiceStorage;
module.exports.InvoiceStorageError = InvoiceStorageError;
module.exports.LocalInvoiceStorageProvider = LocalInvoiceStorageProvider;
module.exports.SupabaseInvoiceStorageProvider = SupabaseInvoiceStorageProvider;
