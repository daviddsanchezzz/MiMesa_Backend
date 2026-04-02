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
    customer:    customerId,
    mode:        'subscription',
    line_items:  [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url:  cancelUrl,
    // Collect card upfront but don't charge for 14 days
    payment_method_collection: 'always',
    metadata: { businessId: businessId.toString() },
    subscription_data: {
      trial_period_days: 14,
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

// ---------- Subscription management ----------

async function cancelSubscriptionAtPeriodEnd(subscriptionId) {
  return getStripe().subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}

async function reactivateSubscription(subscriptionId) {
  return getStripe().subscriptions.update(subscriptionId, { cancel_at_period_end: false });
}

async function getSubscription(subscriptionId) {
  return getStripe().subscriptions.retrieve(subscriptionId);
}

// ---------- Stripe Connect (pagos de clientes al restaurante) ----------

/**
 * Genera la URL de OAuth para que el restaurante conecte su cuenta Stripe.
 */
function getConnectOAuthUrl({ businessId, redirectUri }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.STRIPE_CONNECT_CLIENT_ID,
    scope:         'read_write',
    redirect_uri:  redirectUri,
    state:         businessId.toString(),
  });
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

/**
 * Intercambia el code OAuth por el stripeConnectId (acct_xxx) de la cuenta conectada.
 */
async function exchangeConnectCode(code) {
  const response = await getStripe().oauth.token({
    grant_type: 'authorization_code',
    code,
  });
  return response.stripe_user_id; // acct_xxx
}

/**
 * Desconecta la cuenta Stripe Connect del restaurante.
 */
async function deauthorizeConnectAccount(stripeConnectId) {
  return getStripe().oauth.deauthorize({
    client_id:      process.env.STRIPE_CONNECT_CLIENT_ID,
    stripe_user_id: stripeConnectId,
  });
}

// ---------- Payment Intents (depósito al reservar) ----------

/**
 * Crea un PaymentIntent en la cuenta conectada del restaurante.
 * El dinero va directo a ellos; nosotros podemos añadir application_fee_amount si queremos.
 */
async function createReservationPaymentIntent({ stripeConnectId, amount, currency = 'eur', metadata = {} }) {
  return getStripe().paymentIntents.create(
    {
      amount,
      currency,
      capture_method:       'automatic',
      automatic_payment_methods: { enabled: true },
      metadata,
    },
    { stripeAccount: stripeConnectId },
  );
}

// ---------- Setup Intents (garantía con tarjeta) ----------

/**
 * Crea un SetupIntent en la cuenta conectada para guardar la tarjeta del huésped.
 */
async function createReservationSetupIntent({ stripeConnectId, metadata = {} }) {
  return getStripe().setupIntents.create(
    {
      usage:    'off_session',
      automatic_payment_methods: { enabled: true },
      metadata,
    },
    { stripeAccount: stripeConnectId },
  );
}

/**
 * Crea un Customer de Stripe en la cuenta conectada (para asociar el PaymentMethod).
 */
async function createGuestCustomer({ stripeConnectId, name, email, metadata = {} }) {
  return getStripe().customers.create(
    { name, email, metadata },
    { stripeAccount: stripeConnectId },
  );
}

/**
 * Adjunta un PaymentMethod a un Customer en la cuenta conectada.
 */
async function attachPaymentMethod({ stripeConnectId, paymentMethodId, customerId }) {
  return getStripe().paymentMethods.attach(
    paymentMethodId,
    { customer: customerId },
    { stripeAccount: stripeConnectId },
  );
}

// ---------- Cobro de no-show ----------

/**
 * Cobra la tarjeta guardada de un huésped que no asistió.
 */
async function chargeNoShow({ stripeConnectId, paymentMethodId, customerId, amount, currency = 'eur', metadata = {} }) {
  return getStripe().paymentIntents.create(
    {
      amount,
      currency,
      payment_method: paymentMethodId,
      customer:       customerId,
      confirm:        true,
      off_session:    true,
      metadata,
    },
    { stripeAccount: stripeConnectId },
  );
}

// ---------- Reembolsos ----------

/**
 * Reembolsa un PaymentIntent (total o parcial) en la cuenta conectada.
 */
async function refundPaymentIntent({ stripeConnectId, paymentIntentId, amount }) {
  const params = { payment_intent: paymentIntentId };
  if (amount) params.amount = amount;
  return getStripe().refunds.create(params, { stripeAccount: stripeConnectId });
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
  cancelSubscriptionAtPeriodEnd,
  reactivateSubscription,
  getSubscription,
  constructWebhookEvent,
  planFromPriceId,
  // Connect
  getConnectOAuthUrl,
  exchangeConnectCode,
  deauthorizeConnectAccount,
  // Reservation payments
  createReservationPaymentIntent,
  createReservationSetupIntent,
  createGuestCustomer,
  attachPaymentMethod,
  chargeNoShow,
  refundPaymentIntent,
};
