const Stripe = require('stripe');

let stripeClient = null;

function getStripe() {
  if (!stripeClient) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2025-02-24.acacia',
    });
  }
  return stripeClient;
}

function getCurrency() {
  return (process.env.STRIPE_CURRENCY || 'eur').toLowerCase();
}

async function createCustomer({ email, name, businessId }) {
  return getStripe().customers.create({
    email,
    name,
    metadata: { businessId: businessId.toString() },
  });
}

async function getOrCreateCustomer(business) {
  if (business.stripeCustomerId) return business.stripeCustomerId;
  const customer = await createCustomer({
    email: business.email,
    name: business.name,
    businessId: business._id,
  });
  business.stripeCustomerId = customer.id;
  await business.save();
  return customer.id;
}

async function createCheckoutSession({ customerId, priceId, businessId, successUrl, cancelUrl, trialEnd = null, quantity = 1 }) {
  return getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity }],
    // Founder prices and other offers are Stripe promotion codes
    allow_promotion_codes: true,
    // Spanish businesses need their NIF on the invoice
    tax_id_collection: { enabled: true },
    success_url: successUrl,
    cancel_url: cancelUrl,
    payment_method_collection: 'always',
    metadata: { businessId: businessId.toString() },
    subscription_data: {
      // The trial happens in Vetra without a card; paying during it keeps the
      // remaining days (Stripe needs trial_end at least 48 h ahead).
      ...(trialEnd && trialEnd.getTime() - Date.now() > 48 * 60 * 60 * 1000
        ? { trial_end: Math.floor(trialEnd.getTime() / 1000) } : {}),
      metadata: { businessId: businessId.toString() },
    },
  });
}

async function createPortalSession({ customerId, returnUrl }) {
  return getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

function constructWebhookEvent(rawBody, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  return getStripe().webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET,
  );
}

async function cancelSubscriptionAtPeriodEnd(subscriptionId) {
  return getStripe().subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}

async function reactivateSubscription(subscriptionId) {
  return getStripe().subscriptions.update(subscriptionId, { cancel_at_period_end: false });
}

async function changePlan(subscriptionId, newPriceId, { prorationBehavior = 'always_invoice', quantity = 1 } = {}) {
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const itemId = subscription.items.data[0].id;
  return getStripe().subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: newPriceId, quantity }],
    proration_behavior: prorationBehavior,
  });
}

/** Professionals on Pro: changes the quantity (prorated on the next invoice). */
async function setQuantity(subscriptionId, quantity) {
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const item = subscription.items.data[0];
  if (!item || item.quantity === quantity) return subscription;
  return getStripe().subscriptions.update(subscriptionId, {
    items: [{ id: item.id, quantity }],
    proration_behavior: 'create_prorations',
  });
}

async function getSubscription(subscriptionId) {
  return getStripe().subscriptions.retrieve(subscriptionId);
}

async function createReservationPaymentIntent({ amount, currency, metadata = {} }) {
  return getStripe().paymentIntents.create({
    amount,
    currency: (currency || getCurrency()).toLowerCase(),
    automatic_payment_methods: { enabled: true },
    metadata,
  });
}

async function retrievePaymentIntent(paymentIntentId) {
  return getStripe().paymentIntents.retrieve(paymentIntentId);
}

async function verifyPaymentIntent({ paymentIntentId, expectedAmount }) {
  const paymentIntent = await retrievePaymentIntent(paymentIntentId);
  if (paymentIntent.status !== 'succeeded') {
    throw new Error(`PaymentIntent ${paymentIntentId} is not succeeded (${paymentIntent.status})`);
  }
  if (expectedAmount && paymentIntent.amount !== expectedAmount) {
    throw new Error(`Amount mismatch: expected ${expectedAmount}, received ${paymentIntent.amount}`);
  }
  return paymentIntent;
}

async function refundPaymentIntent({ paymentIntentId, amount }) {
  const params = { payment_intent: paymentIntentId };
  if (amount) params.amount = amount;
  return getStripe().refunds.create(params, {
    idempotencyKey: `refund-${paymentIntentId}${amount ? `-${amount}` : ''}`,
  });
}

/**
 * Stripe price of a plan for a business. Appointment businesses: Basic 24,99 €,
 * Pro 39,99 € (per professional beyond 3). Restaurants: Basic 39,99 €,
 * Pro 69,99 € (STRIPE_PRICE_RESTAURANT_*; until they exist, the general ones).
 */
function priceFor(business, plan) {
  const restaurant = business?.businessType !== 'appointments';
  if (plan === 'basic') return (restaurant && process.env.STRIPE_PRICE_RESTAURANT_BASIC) || process.env.STRIPE_PRICE_BASIC || null;
  if (plan === 'pro') return (restaurant && process.env.STRIPE_PRICE_RESTAURANT_PRO) || process.env.STRIPE_PRICE_PRO || null;
  return null;
}

function planFromPriceId(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_BASIC]: 'basic',
    [process.env.STRIPE_PRICE_PRO]: 'pro',
  };
  if (process.env.STRIPE_PRICE_RESTAURANT_BASIC) map[process.env.STRIPE_PRICE_RESTAURANT_BASIC] = 'basic';
  if (process.env.STRIPE_PRICE_RESTAURANT_PRO) map[process.env.STRIPE_PRICE_RESTAURANT_PRO] = 'pro';
  return map[priceId] ?? 'basic';
}

module.exports = {
  priceFor,
  cancelSubscriptionAtPeriodEnd,
  changePlan,
  setQuantity,
  constructWebhookEvent,
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  createReservationPaymentIntent,
  getCurrency,
  getOrCreateCustomer,
  getSubscription,
  getStripe,
  planFromPriceId,
  reactivateSubscription,
  refundPaymentIntent,
  retrievePaymentIntent,
  verifyPaymentIntent,
};
