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

async function changePlan(subscriptionId, newPriceId, { prorationBehavior = 'always_invoice' } = {}) {
  const sub    = await getStripe().subscriptions.retrieve(subscriptionId);
  const itemId = sub.items.data[0].id;
  return getStripe().subscriptions.update(subscriptionId, {
    items:              [{ id: itemId, price: newPriceId }],
    proration_behavior: prorationBehavior,
  });
}

async function getSubscription(subscriptionId) {
  return getStripe().subscriptions.retrieve(subscriptionId);
}

// ---------- Stripe Connect (Account Links — flujo actual) ----------

/**
 * Crea una cuenta Connect Express vacía para el restaurante.
 * Devuelve el acct_xxx que guardamos en Business.stripeConnectId.
 */
async function createConnectAccount({ businessId, email }) {
  return getStripe().accounts.create({
    type:    'express',
    country: 'ES',
    email,
    capabilities: {
      card_payments: { requested: true },
      transfers:     { requested: true },
    },
    metadata: { businessId: businessId.toString() },
  });
}

/**
 * Genera el enlace de onboarding para que el restaurante complete sus datos bancarios.
 * Tras completarlo, Stripe redirige a returnUrl.
 */
async function createAccountLink({ stripeConnectId, refreshUrl, returnUrl }) {
  return getStripe().accountLinks.create({
    account:     stripeConnectId,
    refresh_url: refreshUrl,
    return_url:  returnUrl,
    type:        'account_onboarding',
  });
}

/**
 * Comprueba si la cuenta Connect tiene pagos y transferencias habilitados.
 */
async function getConnectAccount(stripeConnectId) {
  return getStripe().accounts.retrieve(stripeConnectId);
}

/**
 * Desconecta (elimina) la cuenta Connect del restaurante.
 */
async function deleteConnectAccount(stripeConnectId) {
  return getStripe().accounts.del(stripeConnectId);
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

// ---------- Verificación de intents ----------

/**
 * Verifica en Stripe que un PaymentIntent fue efectivamente cobrado (status=succeeded)
 * y que el importe coincide con el esperado. Lanza error si no.
 */
async function verifyPaymentIntent({ stripeConnectId, paymentIntentId, expectedAmount }) {
  const intent = await getStripe().paymentIntents.retrieve(
    paymentIntentId,
    { stripeAccount: stripeConnectId },
  );
  if (intent.status !== 'succeeded') {
    throw new Error(`PaymentIntent ${paymentIntentId} no está completado (status: ${intent.status})`);
  }
  if (expectedAmount && intent.amount !== expectedAmount) {
    throw new Error(`Importe no coincide: esperado ${expectedAmount}, recibido ${intent.amount}`);
  }
  return intent;
}

/**
 * Verifica en Stripe que un SetupIntent fue completado correctamente (status=succeeded).
 * Devuelve el SetupIntent con el paymentMethod adjunto.
 */
async function verifySetupIntent({ stripeConnectId, setupIntentId }) {
  const intent = await getStripe().setupIntents.retrieve(
    setupIntentId,
    { stripeAccount: stripeConnectId },
  );
  if (intent.status !== 'succeeded') {
    throw new Error(`SetupIntent ${setupIntentId} no está completado (status: ${intent.status})`);
  }
  return intent;
}

// ---------- Reembolsos ----------

/**
 * Reembolsa un PaymentIntent (total o parcial) en la cuenta conectada.
 * Usa idempotency key para evitar dobles reembolsos ante reintentos.
 */
async function refundPaymentIntent({ stripeConnectId, paymentIntentId, amount }) {
  const params = { payment_intent: paymentIntentId };
  if (amount) params.amount = amount;
  return getStripe().refunds.create(params, {
    stripeAccount:  stripeConnectId,
    idempotencyKey: `refund-${paymentIntentId}${amount ? `-${amount}` : ''}`,
  });
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
  verifyPaymentIntent,
  verifySetupIntent,
  // Connect
  createConnectAccount,
  createAccountLink,
  getConnectAccount,
  deleteConnectAccount,
  createCustomer,
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
  cancelSubscriptionAtPeriodEnd,
  reactivateSubscription,
  changePlan,
  getSubscription,
  constructWebhookEvent,
  planFromPriceId,
  // Reservation payments
  createReservationPaymentIntent,
  createReservationSetupIntent,
  createGuestCustomer,
  attachPaymentMethod,
  chargeNoShow,
  refundPaymentIntent,
};
