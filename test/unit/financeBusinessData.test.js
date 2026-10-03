const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const businessData = require('../../core/lib/businessData');

const models = {
  Expense: require('../../modules/finance/models/Expense'),
  RecurringExpense: require('../../modules/finance/models/RecurringExpense'),
  DailyRevenue: require('../../modules/finance/models/DailyRevenue'),
  BusinessCategory: require('../../modules/finance/models/BusinessCategory'),
};
require('../../modules/finance/businessData');

const originals = new Map(Object.entries(models).map(([name, Model]) => [name, Model.deleteMany]));
afterEach(() => {
  for (const [name, Model] of Object.entries(models)) Model.deleteMany = originals.get(name);
});

test('finance business erasure removes every finance collection for only that tenant', async () => {
  const calls = [];
  for (const [name, Model] of Object.entries(models)) {
    Model.deleteMany = async (filter) => {
      calls.push([name, filter]);
      return { deletedCount: 1 };
    };
  }
  const result = await businessData._kinds.get('finance').erase('tenantA');
  assert.equal(calls.length, Object.keys(models).length);
  assert.ok(calls.every(([, filter]) => filter.businessId === 'tenantA'));
  assert.deepEqual(result, { Expense: 1, RecurringExpense: 1, DailyRevenue: 1, BusinessCategory: 1 });
});
