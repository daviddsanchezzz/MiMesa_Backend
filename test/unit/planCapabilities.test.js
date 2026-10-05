const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { lib, load } = require('../helpers/load');

const plans = lib('planCapabilities');

const biz = (plan, subscriptionStatus, extra = {}) => ({ plan, subscriptionStatus, ...extra });

describe('planCapabilities', () => {
  test('paid plan only counts while active or trialing', () => {
    assert.equal(plans.getEffectivePlan(biz('pro', 'active')), 'pro');
    assert.equal(plans.getEffectivePlan(biz('basic', 'trialing', { stripeSubscriptionId: 'sub_1' })), 'basic');
    assert.equal(plans.getEffectivePlan(biz('pro', 'past_due')), 'expired', 'past_due without a recorded failure date: no grace');
    assert.equal(plans.getEffectivePlan(biz('pro', 'canceled')), 'expired');
    assert.equal(plans.getEffectivePlan(biz('pro', null)), 'expired');
    assert.equal(plans.getEffectivePlan(biz('enterprise', 'active')), 'expired');
    // Businesses from before trials keep the old free access
    assert.equal(plans.getEffectivePlan(biz('free', null, { legacyAccess: true })), 'free');
    assert.equal(plans.getEffectivePlan(biz('pro', 'canceled', { legacyAccess: true })), 'free');
  });

  test('our own trial (no card) lasts until trialEndsAt; a Stripe trial until Stripe says', () => {
    const day = 86400000;
    assert.equal(plans.getEffectivePlan(biz('pro', 'trialing', { trialEndsAt: new Date(Date.now() + day) })), 'pro');
    assert.equal(plans.getEffectivePlan(biz('pro', 'trialing', { trialEndsAt: new Date(Date.now() - day) })), 'expired');
    assert.equal(plans.getEffectivePlan(biz('pro', 'trialing', { trialEndsAt: null })), 'expired');
    assert.equal(plans.getEffectivePlan(biz('basic', 'trialing', { stripeSubscriptionId: 'sub_1', trialEndsAt: new Date(Date.now() - day) })), 'basic');
  });

  test('without a plan: read-only, no bookings', () => {
    const caps = plans.getCapabilities(biz('free', null));
    assert.equal(caps.id, 'expired');
    assert.equal(caps.readOnly, true);
    assert.equal(caps.maxBookingsPerMonth, 0);
    assert.equal(caps.maxReservationsPerMonth, 0);
  });

  test('free plan limits (only businesses from before trials)', () => {
    const caps = plans.getCapabilities(biz('free', null, { legacyAccess: true }));
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

  test('appointment businesses get the agenda by default (can still be turned off)', () => {
    assert.equal(plans.canUseModule(biz('free', null, { businessType: 'appointments' }), 'bookings'), true);
    assert.equal(plans.canUseModule(biz('free', null, { businessType: 'restaurant' }), 'bookings'), false);
    assert.equal(plans.canUseModule(biz('pro', 'active', { businessType: 'appointments', moduleOverrides: { bookings: { enabled: false } } }), 'bookings'), false);
  });

  test('bookings module is opt-in per business on every plan', () => {
    for (const plan of [biz('free', null), biz('basic', 'active'), biz('pro', 'active')]) {
      assert.equal(plans.canUseModule(plan, 'bookings'), false);
      assert.equal(plans.canUseModule({ ...plan, moduleOverrides: { bookings: { enabled: true } } }, 'bookings'), true);
    }
  });

  test('without a plan the money and team screens stay readable (writes are blocked elsewhere)', () => {
    const expired = biz('pro', 'canceled');
    for (const key of ['expenses', 'purchases', 'staff']) assert.equal(plans.canUseModule(expired, key), true, key);
    assert.equal(plans.canUseModule(expired, 'thefork'), false);
    // a paying Basic plan still does not include them
    for (const key of ['expenses', 'purchases', 'staff']) assert.equal(plans.canUseModule(biz('basic', 'active'), key), false, key);
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

// ── Failed payment: plan kept while Stripe retries ──────────────────────────
const { test: t2 } = require('node:test');
const assert2 = require('node:assert/strict');
const caps2 = require('../helpers/load').load('core/lib/planCapabilities');

t2('past_due keeps the plan for the grace period, then goes read-only', () => {
  const day = 24 * 60 * 60 * 1000;
  const recent = { plan: 'pro', subscriptionStatus: 'past_due', paymentFailedAt: new Date(Date.now() - 3 * day) };
  const old = { plan: 'pro', subscriptionStatus: 'past_due', paymentFailedAt: new Date(Date.now() - (caps2.PAYMENT_GRACE_DAYS + 1) * day) };
  assert2.equal(caps2.getEffectivePlan(recent), 'pro');
  assert2.equal(caps2.getEffectivePlan(old), 'expired');
  assert2.equal(caps2.getEffectivePlan({ plan: 'basic', subscriptionStatus: 'canceled', paymentFailedAt: null }), 'expired');
});

t2('payment failed email: grace date and link to update the card', () => {
  const { buildPaymentFailedEmail } = require('../helpers/load').load('core/services/billingEmails');
  const { subject, html } = buildPaymentFailedEmail({ name: 'Salón <b>Luz</b>' }, { amount: 3900, now: new Date('2026-10-01T10:00:00Z') });
  assert2.match(subject, /No hemos podido cobrar/);
  assert2.match(html, /15 de octubre/);
  assert2.match(html, /39,00 €/);
  assert2.match(html, /configuracion\?tab=suscripcion/);
  assert2.ok(!html.includes('<b>Luz</b>'), 'business name escaped');
});

t2('each business type has its own Stripe prices (restaurants fall back until set)', () => {
  const stripe = require('../helpers/load').load('core/services/stripe');
  const appt = { businessType: 'appointments' };
  const rest = { businessType: 'restaurant' };
  assert2.equal(stripe.priceFor(appt, 'basic'), process.env.STRIPE_PRICE_BASIC);
  assert2.equal(stripe.priceFor(rest, 'pro'), process.env.STRIPE_PRICE_PRO, 'no restaurant price yet: general one');
  process.env.STRIPE_PRICE_RESTAURANT_BASIC = 'price_rest_basic';
  process.env.STRIPE_PRICE_RESTAURANT_PRO = 'price_rest_pro';
  try {
    assert2.equal(stripe.priceFor(rest, 'basic'), 'price_rest_basic');
    assert2.equal(stripe.priceFor(rest, 'pro'), 'price_rest_pro');
    assert2.equal(stripe.priceFor(appt, 'pro'), process.env.STRIPE_PRICE_PRO);
    assert2.equal(stripe.planFromPriceId('price_rest_pro'), 'pro');
    assert2.equal(stripe.priceFor(rest, 'gold'), null);
  } finally {
    delete process.env.STRIPE_PRICE_RESTAURANT_BASIC;
    delete process.env.STRIPE_PRICE_RESTAURANT_PRO;
  }
});
