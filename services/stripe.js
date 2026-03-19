/**
 * Stripe service — isolated from auth and business logic.
 *
 * All Stripe API calls go through here so the provider can be
 * swapped or mocked in tests without touching controllers.
 */

const Stripe = require('stripe');

// Lazy initialisation — avoids crash when STRIPE_SECRET_KEY is not set yet
let _stripe = null;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' });
  }
  return _stripe;
}

// ---------- Customers ----------

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
    email:      business.email,
    name:       business.name,
    businessId: business._id,
  });
  business.stripeCustomerId = customer.id;
  await business.save();
  return customer.id;
}

// ---------- Checkout ----------

async function createCheckoutSession({ customerId, priceId, businessId, successUrl, cancelUrl }) {
  return getStripe().checkout.sessions.create({
    customer:  customerId,
    mode:      'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url:  cancelUrl,
    metadata: { businessId: businessId.toString() },
    subscription_data: {
      metadata: { businessId: businessId.toString() },
    },
  });
}

// ---------- Customer portal (manage billing) ----------

async function createPortalSession({ customerId, returnUrl }) {
  return getStripe().billingPortal.sessions.create({
    customer:   customerId,
    return_url: returnUrl,
  });
}

// ---------- Webhooks ----------

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

// ---------- Helpers ----------

/**
 * Maps a Stripe Price ID to an internal plan name.
 * Add entries here when you create new prices in the Stripe dashboard.
 */
function planFromPriceId(priceId) {
  return {
    [process.env.STRIPE_PRICE_BASIC]: 'basic',
    [process.env.STRIPE_PRICE_PRO]:   'pro',
  }[priceId] ?? 'basic';
}

module.exports = {
  createCustomer,
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  planFromPriceId,
};
