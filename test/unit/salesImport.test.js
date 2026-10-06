const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRows, planImport } = require('../../modules/finance/lib/salesImport');

describe('salesImport.normalizeRows', () => {
  test('validates dates and amounts, leaving out the rows with errors', () => {
    const { rows, errors } = normalizeRows([
      { date: '2026-10-01', total: 1250.5, tickets: 48, covers: 90 },
      { date: '01/10/2026', total: 10 },
      { date: '2026-10-02', total: -5 },
      { date: '2026-10-03' },
    ]);
    assert.deepEqual(rows.map((r) => r.date), ['2026-10-01']);
    assert.equal(rows[0].total, 1250.5);
    assert.equal(rows[0].tickets, 48);
    assert.deepEqual(errors.map((e) => e.line), [2, 3, 4]);
  });

  test('a total missing is the sum of the payment methods', () => {
    const { rows } = normalizeRows([{ date: '2026-10-01', cash: 100, card: 250.25, bizum: 0 }]);
    assert.equal(rows[0].total, 350.25);
  });

  test('lines of the same day (one per payment method) add up, oldest day first', () => {
    const { rows } = normalizeRows([
      { date: '2026-10-02', total: 300, card: 300 },
      { date: '2026-10-01', total: 100, cash: 100 },
      { date: '2026-10-02', total: 120, cash: 120 },
    ]);
    assert.deepEqual(rows.map((r) => r.date), ['2026-10-01', '2026-10-02']);
    assert.equal(rows[1].total, 420);
    assert.equal(rows[1].cash, 120);
    assert.equal(rows[1].card, 300);
  });

  test('empty or oversized input is refused', () => {
    assert.equal(normalizeRows([]).rows.length, 0);
    assert.equal(normalizeRows('x').errors.length, 1);
    assert.equal(normalizeRows(Array.from({ length: 401 }, () => ({ date: '2026-10-01', total: 1 }))).rows.length, 0);
  });
});

describe('salesImport.planImport', () => {
  const rows = [
    { date: '2026-10-01', total: 500, cash: null, card: null, bizum: null, other: null, tickets: null, covers: null, tips: null },
    { date: '2026-10-02', total: 800, cash: null, card: null, bizum: null, other: null, tickets: null, covers: null, tips: null },
    { date: '2026-10-03', total: 900, cash: null, card: null, bizum: null, other: null, tickets: null, covers: null, tips: null },
  ];
  const existing = new Map([
    ['2026-10-02', { actualRevenue: 700, source: 'manual' }],
    ['2026-10-03', { actualRevenue: 900, source: 'import' }],
  ]);

  test('new, update and same days', () => {
    const plan = planImport(rows, existing);
    assert.deepEqual(plan.map((p) => p.status), ['new', 'update', 'same']);
    assert.equal(plan[1].previous, 700);
    assert.equal(plan[1].manualPrevious, true);
  });

  test('"only empty days" leaves what is already there', () => {
    assert.deepEqual(planImport(rows, existing, { overwrite: 'empty' }).map((p) => p.status), ['new', 'skip', 'same']);
  });

  test('flags a figure far from the usual and methods that do not add up', () => {
    const plan = planImport([{ ...rows[0], total: 5000 }, { ...rows[0], date: '2026-10-09', total: 500, cash: 100, card: 100 }], new Map(), { average: 800 });
    assert.ok(plan[0].warnings.some((w) => /habitual/.test(w)));
    assert.ok(plan[1].warnings.some((w) => /suman/.test(w)));
  });
});
