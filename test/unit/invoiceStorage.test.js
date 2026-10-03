const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SupabaseInvoiceStorageProvider,
} = require('../../modules/purchases/services/invoiceStorage');

function fakeClient(api) {
  const buckets = [];
  return {
    buckets,
    client: {
      storage: {
        from(bucket) {
          buckets.push(bucket);
          return api;
        },
      },
    },
  };
}

describe('Supabase invoice storage', () => {
  test('uploads the original Buffer to the configured bucket and deterministic MIME path', async () => {
    let uploaded;
    const fake = fakeClient({
      async upload(key, buffer, options) {
        uploaded = { key, buffer, options };
        return { data: { path: key }, error: null };
      },
    });
    const storage = new SupabaseInvoiceStorageProvider({ client: fake.client, bucket: 'private-invoices' });
    const buffer = Buffer.from('original bytes');

    const key = await storage.store({ businessId: 'businessA', invoiceId: 'invoice1', mimeType: 'image/jpeg', buffer });

    assert.equal(key, 'businessA/invoice1/original.jpg');
    assert.equal(fake.buckets[0], 'private-invoices');
    assert.strictEqual(uploaded.buffer, buffer);
    assert.deepEqual(uploaded.options, { contentType: 'image/jpeg', upsert: false });
  });

  test('rejects unsupported MIME types before calling Supabase', async () => {
    let called = false;
    const fake = fakeClient({ upload: async () => { called = true; } });
    const storage = new SupabaseInvoiceStorageProvider({ client: fake.client });
    await assert.rejects(
      storage.store({ businessId: 'businessA', invoiceId: 'invoice1', mimeType: 'text/plain', buffer: Buffer.from('x') }),
      (error) => error.code === 'INVALID_MIME_TYPE',
    );
    assert.equal(called, false);
  });

  test('creates a signed URL with a 60-second expiry', async () => {
    let args;
    const fake = fakeClient({
      async createSignedUrl(...value) {
        args = value;
        return { data: { signedUrl: 'https://storage.test/signed' }, error: null };
      },
    });
    const storage = new SupabaseInvoiceStorageProvider({ client: fake.client });
    const result = await storage.access('businessA/invoice1/original.pdf', { expiresIn: 60 });
    assert.deepEqual(args, ['businessA/invoice1/original.pdf', 60]);
    assert.deepEqual(result, { type: 'redirect', url: 'https://storage.test/signed', expiresIn: 60 });
  });

  test('surfaces signed URL, upload, and delete failures as controlled errors', async () => {
    const providerFor = (api) => new SupabaseInvoiceStorageProvider({ client: fakeClient(api).client });
    await assert.rejects(
      providerFor({ upload: async () => ({ error: new Error('remote') }) })
        .store({ businessId: 'businessA', invoiceId: 'invoice1', mimeType: 'application/pdf', buffer: Buffer.from('x') }),
      (error) => error.code === 'DOCUMENT_UPLOAD_FAILED' && error.message === 'No se pudo subir el documento',
    );
    await assert.rejects(
      providerFor({ createSignedUrl: async () => ({ data: null, error: new Error('remote') }) })
        .access('businessA/invoice1/original.pdf'),
      (error) => error.code === 'SIGNED_URL_FAILED',
    );
    const notFound = new Error('not found');
    notFound.statusCode = 404;
    await assert.rejects(
      providerFor({ createSignedUrl: async () => ({ data: null, error: notFound }) })
        .access('businessA/invoice1/original.pdf'),
      (error) => error.code === 'DOCUMENT_NOT_FOUND',
    );
    await assert.rejects(
      providerFor({ remove: async () => ({ error: new Error('remote') }) })
        .remove('businessA/invoice1/original.pdf'),
      (error) => error.code === 'DOCUMENT_DELETE_FAILED',
    );
  });

  test('deletes one exact object and never changes its tenant prefix', async () => {
    const removed = [];
    const fake = fakeClient({
      async remove(keys) { removed.push(keys); return { error: null }; },
    });
    const storage = new SupabaseInvoiceStorageProvider({ client: fake.client });
    await storage.remove('tenantA/invoice1/original.webp');
    assert.deepEqual(removed, [['tenantA/invoice1/original.webp']]);
    await assert.rejects(storage.remove('../tenantB/invoice2/original.webp'), /Clave de documento no valida/);
  });

  test('paginates a full business prefix and removes only that tenant in batches', async () => {
    const folders = Array.from({ length: 101 }, (_, index) => ({ name: `invoice${index}`, id: null, metadata: null }));
    const listCalls = [];
    const removed = [];
    const fake = fakeClient({
      async list(prefix, options) {
        listCalls.push({ prefix, ...options });
        if (prefix === 'tenantA') return { data: folders.slice(options.offset, options.offset + options.limit), error: null };
        return { data: [{ name: 'original.pdf', id: `id-${prefix}`, metadata: { size: 10 } }], error: null };
      },
      async remove(keys) { removed.push(keys); return { error: null }; },
    });
    const storage = new SupabaseInvoiceStorageProvider({ client: fake.client });

    const count = await storage.removeBusiness('tenantA');

    assert.equal(count, 101);
    assert.ok(listCalls.some((call) => call.prefix === 'tenantA' && call.offset === 100));
    assert.deepEqual(removed.map((batch) => batch.length), [100, 1]);
    assert.ok(removed.flat().every((key) => key.startsWith('tenantA/')));
    assert.ok(removed.flat().every((key) => !key.startsWith('tenantB/')));
  });

  test('aborts a business purge when listing or deleting fails', async () => {
    const listing = new SupabaseInvoiceStorageProvider({ client: fakeClient({
      list: async () => ({ data: null, error: new Error('remote') }),
    }).client });
    await assert.rejects(listing.removeBusiness('tenantA'), (error) => error.code === 'DOCUMENT_LIST_FAILED');

    const deleting = new SupabaseInvoiceStorageProvider({ client: fakeClient({
      list: async (prefix) => (prefix === 'tenantA'
        ? { data: [{ name: 'invoice1', id: null, metadata: null }], error: null }
        : { data: [{ name: 'original.pdf', id: 'id', metadata: {} }], error: null }),
      remove: async () => ({ error: new Error('remote') }),
    }).client });
    await assert.rejects(deleting.removeBusiness('tenantA'), (error) => error.code === 'BUSINESS_DOCUMENT_DELETE_FAILED');
  });
});
