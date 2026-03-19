const Business  = require('../models/Business');
const stripeService = require('../services/stripe');

// ── POST /api/stripe/checkout ──────────────────────────────────────────────
// Creates a Stripe Checkout session and returns the redirect URL.
// Frontend opens that URL to let the user pay.
exports.createCheckoutSession = async (req, res) => {
  try {
    const { priceId } = req.body;
    if (!priceId) return res.status(400).json({ message: 'priceId is required' });

    const business    = await Business.findById(req.businessId);
    if (!business)    return res.status(404).json({ message: 'Business not found' });

    const customerId  = await stripeService.getOrCreateCustomer(business);

    const session = await stripeService.createCheckoutSession({
      customerId,
      priceId,
      businessId:  business._id,
      successUrl:  `${process.env.FRONTEND_URL}/settings?subscription=success`,
      cancelUrl:   `${process.env.FRONTEND_URL}/settings?subscription=canceled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/stripe/portal ────────────────────────────────────────────────
// Opens the Stripe Customer Portal so the user can manage their subscription.
exports.createPortalSession = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId);
    if (!business?.stripeCustomerId) {
      return res.status(400).json({ message: 'No hay suscripción activa' });
    }

    const session = await stripeService.createPortalSession({
      customerId: business.stripeCustomerId,
      returnUrl:  `${process.env.FRONTEND_URL}/settings`,
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/stripe/webhook ───────────────────────────────────────────────
// Stripe calls this endpoint on subscription events.
// Must receive the RAW request body to validate the signature.
exports.handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, sig);
  } catch (err) {
    console.error('[stripe webhook] Invalid signature:', err.message);
    return res.status(400).json({ message: `Webhook error: ${err.message}` });
  }

  try {
    await handleEvent(event);
  } catch (err) {
    console.error('[stripe webhook] Handler error:', err.message);
    // Return 200 so Stripe doesn't retry — log and investigate separately
  }

  res.json({ received: true });
};

// ── Event handlers ─────────────────────────────────────────────────────────

async function handleEvent(event) {
  switch (event.type) {

    case 'checkout.session.completed': {
      const session    = event.data.object;
      const businessId = session.metadata?.businessId;
      if (!businessId) break;

      await Business.findByIdAndUpdate(businessId, {
        stripeSubscriptionId: session.subscription,
        stripeCustomerId:     session.customer,
        subscriptionStatus:   'active',
        // Plan will be set precisely on invoice.payment_succeeded
      });
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      if (!invoice.subscription) break;

      // Resolve businessId from subscription metadata
      const businessId = await getBusinessIdFromSubscription(invoice.subscription);
      if (!businessId) break;

      const priceId = invoice.lines?.data?.[0]?.price?.id;
      await Business.findByIdAndUpdate(businessId, {
        subscriptionStatus: 'active',
        plan: stripeService.planFromPriceId(priceId),
      });
      break;
    }

    case 'customer.subscription.updated': {
      const sub        = event.data.object;
      const businessId = sub.metadata?.businessId;
      if (!businessId) break;

      const priceId = sub.items?.data?.[0]?.price?.id;
      await Business.findByIdAndUpdate(businessId, {
        subscriptionStatus: sub.status,
        plan: sub.status === 'active' ? stripeService.planFromPriceId(priceId) : undefined,
      });
      break;
    }

    case 'customer.subscription.deleted': {
      const sub        = event.data.object;
      const businessId = sub.metadata?.businessId;
      if (!businessId) break;

      await Business.findByIdAndUpdate(businessId, {
        subscriptionStatus:   'canceled',
        plan:                 'free',
        stripeSubscriptionId: null,
      });
      break;
    }

    default:
      // Unhandled event types — safe to ignore
      break;
  }
}

// Fallback: retrieve businessId from subscription metadata via Stripe API
async function getBusinessIdFromSubscription(subscriptionId) {
  try {
    // Look up locally first (cheaper)
    const business = await Business.findOne({ stripeSubscriptionId: subscriptionId });
    if (business) return business._id.toString();

    // Not found locally — fetch from Stripe
    const { stripeService: s } = require('../services/stripe');
    const sub = await s.getSubscription?.(subscriptionId);
    return sub?.metadata?.businessId ?? null;
  } catch {
    return null;
  }
}
