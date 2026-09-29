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

async function createCheckoutSession({ customerId, priceId, businessId, successUrl, cancelUrl }) {
  return getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    payment_method_collection: 'always',
    metadata: { businessId: businessId.toString() },
    subscription_data: {
      trial_period_days: 14,
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

async function changePlan(subscriptionId, newPriceId, { prorationBehavior = 'always_invoice' } = {}) {
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const itemId = subscription.items.data[0].id;
  return getStripe().subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: prorationBehavior,
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

function planFromPriceId(priceId) {
  return {
    [process.env.STRIPE_PRICE_BASIC]: 'basic',
    [process.env.STRIPE_PRICE_PRO]: 'pro',
  }[priceId] ?? 'basic';
}

module.exports = {
  cancelSubscriptionAtPeriodEnd,
  changePlan,
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
