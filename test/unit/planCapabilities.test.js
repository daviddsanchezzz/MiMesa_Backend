const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { lib, load } = require('../helpers/load');

const plans = lib('planCapabilities');

const biz = (plan, subscriptionStatus, extra = {}) => ({ plan, subscriptionStatus, ...extra });

describe('planCapabilities', () => {
  test('paid plan only counts while active or trialing', () => {
    assert.equal(plans.getEffectivePlan(biz('pro', 'active')), 'pro');
    assert.equal(plans.getEffectivePlan(biz('basic', 'trialing')), 'basic');
    assert.equal(plans.getEffectivePlan(biz('pro', 'past_due')), 'free');
    assert.equal(plans.getEffectivePlan(biz('pro', 'canceled')), 'free');
    assert.equal(plans.getEffectivePlan(biz('pro', null)), 'free');
    assert.equal(plans.getEffectivePlan(biz('enterprise', 'active')), 'free');
  });

  test('free plan limits', () => {
    const caps = plans.getCapabilities(biz('free', null));
    assert.equal(caps.maxReservationsPerMonth, 30);
    assert.equal(caps.maxTables, 15);
    assert.equal(caps.maxMembers, 1);
    assert.equal(caps.marketing, false);
  });

  test('canUseFeature treats Infinity as allowed', () => {
    assert.equal(plans.canUseFeature(biz('basic', 'active'), 'maxTables'), true);
    assert.equal(plans.canUseFeature(biz('free', null), 'maxTables'), false);
    assert.equal(plans.canUseFeature(biz('pro', 'active'), 'marketing'), true);
    assert.equal(plans.canUseFeature(biz('basic', 'active'), 'marketing'), false);
  });

  test('serializeCapabilities turns Infinity into null and hides modules', () => {
    const out = plans.serializeCapabilities(biz('pro', 'active'));
    assert.equal(out.maxTables, null);
    assert.equal(out.modulesAllowed, undefined);
    assert.equal(out.marketing, true);
  });

  test('upgradeMessage names the cheapest plan', () => {
    assert.equal(plans.upgradeMessage('autoEmails'), 'Esta función requiere el plan Basic o superior');
    assert.equal(plans.upgradeMessage('marketing'), 'Esta función requiere el plan Pro');
    assert.equal(plans.upgradeMessage('doesNotExist'), 'Esta función no está disponible en tu plan');
  });

  test('module access = allowed by plan AND not disabled by override', () => {
    const pro = biz('pro', 'active');
    assert.deepEqual(plans.getModuleAccess(pro, 'staff'), { moduleKey: 'staff', allowedByPlan: true, overrideEnabled: true, enabled: true });
    assert.equal(plans.canUseModule(biz('pro', 'active', { moduleOverrides: { staff: { enabled: false } } }), 'staff'), false);
    assert.equal(plans.canUseModule(biz('basic', 'active'), 'staff'), false);
    // thefork is off by default even when the plan allows it
    assert.equal(plans.canUseModule(pro, 'thefork'), false);
    assert.equal(plans.canUseModule(biz('pro', 'active', { moduleOverrides: { thefork: { enabled: true } } }), 'thefork'), true);
  });

  test('getAllModuleAccess lists every module of the plan', () => {
    assert.deepEqual(Object.keys(plans.getAllModuleAccess(biz('pro', 'active'))).sort(), ['bookings', 'expenses', 'purchases', 'staff', 'thefork']);
  });

  test('bookings module is opt-in per business on every plan', () => {
    for (const plan of [biz('free', null), biz('basic', 'active'), biz('pro', 'active')]) {
      assert.equal(plans.canUseModule(plan, 'bookings'), false);
      assert.equal(plans.canUseModule({ ...plan, moduleOverrides: { bookings: { enabled: true } } }, 'bookings'), true);
    }
  });

  test('checkReservationLimit short-circuits on unlimited plans', async () => {
    const { checkReservationLimit } = load('verticals/restaurant/lib/reservationLimits');
    assert.deepEqual(await checkReservationLimit('id', biz('pro', 'active')), { allowed: true });
  });

  test('markLockedEntities locks items beyond the limit', () => {
    const out = plans.markLockedEntities([{ n: 1 }, { n: 2 }, { n: 3 }], 2);
    assert.deepEqual(out.map((o) => o.isLocked), [false, false, true]);
    assert.deepEqual(plans.markLockedEntities([{ n: 1 }], Infinity).map((o) => o.isLocked), [false]);
    const doc = { toObject: () => ({ n: 9 }) };
    assert.deepEqual(plans.markLockedEntities([doc], 5), [{ n: 9, isLocked: false }]);
  });
});
