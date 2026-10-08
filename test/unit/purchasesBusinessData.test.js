const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../../modules/purchases/services/invoiceStorage');
const businessData = require('../../core/lib/businessData');
const models = {
  InvoiceItem: require('../../modules/purchases/models/InvoiceItem'),
  Invoice: require('../../modules/purchases/models/Invoice'),
  Recipe: require('../../modules/purchases/models/Recipe'),
  IngredientPrice: require('../../modules/purchases/models/IngredientPrice'),
  Ingredient: require('../../modules/purchases/models/Ingredient'),
  CostSettings: require('../../modules/purchases/models/CostSettings'),
  PurchaseOrder: require('../../modules/purchases/models/PurchaseOrder'),
  PurchaseProduct: require('../../modules/purchases/models/PurchaseProduct'),
  Supplier: require('../../modules/purchases/models/Supplier'),
};

require('../../modules/purchases/businessData');

const originals = new Map(Object.entries(models).map(([name, Model]) => [name, Model.deleteMany]));

afterEach(() => {
  for (const [name, Model] of Object.entries(models)) Model.deleteMany = originals.get(name);
  storage.resetProviderForTests();
});

describe('purchases business data erasure', () => {
  test('purges the exact tenant prefix before deleting its Mongo collections', async () => {
    const events = [];
    storage.setProviderForTests({
      kind: 'supabase',
      async removeBusiness(businessId) { events.push(`storage:${businessId}`); },
    });
    for (const [name, Model] of Object.entries(models)) {
      Model.deleteMany = async (filter) => {
        events.push(`mongo:${name}:${filter.businessId}`);
        return { deletedCount: 0 };
      };
    }

    await businessData._kinds.get('purchases').erase('tenantA');

    assert.equal(events[0], 'storage:tenantA');
    assert.equal(events.length, 1 + Object.keys(models).length);
    assert.ok(events.slice(1).every((event) => event.endsWith(':tenantA')));
  });

  test('does not delete Mongo data if the tenant storage purge fails', async () => {
    let mongoCalls = 0;
    storage.setProviderForTests({
      kind: 'supabase',
      async removeBusiness() { throw new Error('purge failed'); },
    });
    for (const Model of Object.values(models)) {
      Model.deleteMany = async () => { mongoCalls += 1; return { deletedCount: 0 }; };
    }

    await assert.rejects(businessData._kinds.get('purchases').erase('tenantA'), /purge failed/);
    assert.equal(mongoCalls, 0);
  });
});
