const Business      = require('../models/Business');
const Reservation   = require('../models/Reservation');
const stripeService = require('../services/stripe');
const { getEffectivePlan, checkReservationLimit } = require('../lib/planCapabilities');

// ── POST /api/stripe/checkout ──────────────────────────────────────────────
// Creates a Stripe Checkout session with 14-day trial and returns the redirect URL.
exports.createCheckoutSession = async (req, res) => {
  try {
    const { priceId } = req.body;
    if (!priceId) return res.status(400).json({ message: 'priceId is required' });

    const business   = await Business.findById(req.businessId);
    if (!business)   return res.status(404).json({ message: 'Business not found' });

    // Prevent duplicate subscriptions
    if (business.stripeSubscriptionId && ['active', 'trialing'].includes(business.subscriptionStatus)) {
      return res.status(400).json({ message: 'Ya tienes una suscripción activa' });
    }

    const customerId = await stripeService.getOrCreateCustomer(business);

    const session = await stripeService.createCheckoutSession({
      customerId,
      priceId,
      businessId:  business._id,
      successUrl:  `${process.env.FRONTEND_URL}/configuracion?tab=suscripcion&subscription=success`,
      cancelUrl:   `${process.env.FRONTEND_URL}/configuracion?tab=suscripcion&subscription=canceled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe checkout]', err.message);
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
      returnUrl:  `${process.env.FRONTEND_URL}/configuracion?tab=suscripcion`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe portal]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/stripe/cancel ────────────────────────────────────────────────
// Cancels the subscription at the end of the current period (no immediate effect).
exports.cancelSubscription = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId);
    if (!business?.stripeSubscriptionId) {
      return res.status(400).json({ message: 'No hay suscripción activa' });
    }
    if (business.cancelAtPeriodEnd) {
      return res.status(400).json({ message: 'La suscripción ya está programada para cancelarse' });
    }

    await stripeService.cancelSubscriptionAtPeriodEnd(business.stripeSubscriptionId);
    // Stripe will fire customer.subscription.updated — we update DB there.
    // Optimistically update to avoid UI lag:
    await Business.findByIdAndUpdate(req.businessId, { cancelAtPeriodEnd: true });

    res.json({ message: 'Suscripción programada para cancelar al final del período' });
  } catch (err) {
    console.error('[stripe cancel]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/stripe/reactivate ───────────────────────────────────────────
// Reactivates a subscription that was set to cancel at period end.
exports.reactivateSubscription = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId);
    if (!business?.stripeSubscriptionId) {
      return res.status(400).json({ message: 'No hay suscripción activa' });
    }
    if (!business.cancelAtPeriodEnd) {
      return res.status(400).json({ message: 'La suscripción no está pendiente de cancelación' });
    }

    await stripeService.reactivateSubscription(business.stripeSubscriptionId);
    await Business.findByIdAndUpdate(req.businessId, { cancelAtPeriodEnd: false });

    res.json({ message: 'Suscripción reactivada' });
  } catch (err) {
    console.error('[stripe reactivate]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/stripe/status ─────────────────────────────────────────────────
// Returns current billing status + monthly usage for the billing UI.
exports.getBillingStatus = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId)
      .select('plan subscriptionStatus trialEndsAt currentPeriodEnd cancelAtPeriodEnd stripeCustomerId stripeSubscriptionId');
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const effectivePlan = getEffectivePlan(business);
    const limitResult   = await checkReservationLimit(req.businessId, business);

    res.json({
      plan:               effectivePlan,
      subscriptionStatus: business.subscriptionStatus,
      trialEndsAt:        business.trialEndsAt,
      currentPeriodEnd:   business.currentPeriodEnd,
      cancelAtPeriodEnd:  business.cancelAtPeriodEnd,
      hasStripeCustomer:  !!business.stripeCustomerId,
      usage: {
        reservations: {
          used:  limitResult.used  ?? 0,
          limit: limitResult.limit ?? null,
        },
      },
    });
  } catch (err) {
    console.error('[stripe status]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/stripe/webhook ───────────────────────────────────────────────
// Stripe calls this on subscription events. Uses raw body for signature validation.
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
    console.error('[stripe webhook] Handler error:', err.message, '| event:', event.type);
    // Return 200 so Stripe doesn't retry — investigate separately
  }

  res.json({ received: true });
};

// ── Event handlers ─────────────────────────────────────────────────────────

async function handleEvent(event) {
  const log = (msg) => console.log(`[stripe webhook] ${event.type} — ${msg}`);

  switch (event.type) {

    // ── Checkout completed — subscription was created via hosted checkout ──
    case 'checkout.session.completed': {
      const session    = event.data.object;
      const businessId = session.metadata?.businessId;
      if (!businessId || session.mode !== 'subscription') break;

      log(`businessId=${businessId}`);
      await Business.findByIdAndUpdate(businessId, {
        stripeCustomerId:     session.customer,
        stripeSubscriptionId: session.subscription,
        // Status will be set precisely by customer.subscription.created/updated
      });
      break;
    }

    // ── Subscription created (fires right after checkout.session.completed) ─
    case 'customer.subscription.created':
    // ── Subscription updated (plan change, status change, cancel scheduled) ─
    case 'customer.subscription.updated': {
      const sub        = event.data.object;
      const businessId = await resolveBusinessId(sub);
      if (!businessId) { log('businessId not found'); break; }

      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan    = stripeService.planFromPriceId(priceId);

      const update = {
        subscriptionStatus:  sub.status,
        cancelAtPeriodEnd:   sub.cancel_at_period_end ?? false,
        currentPeriodEnd:    sub.current_period_end
                               ? new Date(sub.current_period_end * 1000)
                               : null,
        trialEndsAt:         sub.trial_end
                               ? new Date(sub.trial_end * 1000)
                               : null,
      };

      // Only update plan if subscription is in a good state
      if (['active', 'trialing'].includes(sub.status)) {
        update.plan = plan;
      }

      log(`businessId=${businessId} status=${sub.status} plan=${plan} cancelAtPeriodEnd=${sub.cancel_at_period_end}`);
      await Business.findByIdAndUpdate(businessId, update);
      break;
    }

    // ── Invoice paid — periodic payment succeeded ──────────────────────────
    case 'invoice.paid': {
      const invoice = event.data.object;
      if (!invoice.subscription) break;

      const businessId = await resolveBusinessIdFromInvoice(invoice);
      if (!businessId) { log('businessId not found'); break; }

      const priceId = invoice.lines?.data?.[0]?.price?.id;
      const plan    = stripeService.planFromPriceId(priceId);
      const periodEnd = invoice.lines?.data?.[0]?.period?.end;

      log(`businessId=${businessId} plan=${plan}`);
      await Business.findByIdAndUpdate(businessId, {
        subscriptionStatus: 'active',
        plan,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : undefined,
      });
      break;
    }

    // ── Invoice payment failed ─────────────────────────────────────────────
    case 'invoice.payment_failed': {
      const invoice    = event.data.object;
      if (!invoice.subscription) break;

      const businessId = await resolveBusinessIdFromInvoice(invoice);
      if (!businessId) { log('businessId not found'); break; }

      log(`businessId=${businessId} — payment failed`);
      await Business.findByIdAndUpdate(businessId, { subscriptionStatus: 'past_due' });
      break;
    }

    // ── Subscription deleted (trial expired without card, cancellation effective) ─
    case 'customer.subscription.deleted': {
      const sub        = event.data.object;
      const businessId = await resolveBusinessId(sub);
      if (!businessId) { log('businessId not found'); break; }

      log(`businessId=${businessId} — downgrading to free`);
      await Business.findByIdAndUpdate(businessId, {
        subscriptionStatus:   'canceled',
        plan:                 'free',
        stripeSubscriptionId: null,
        cancelAtPeriodEnd:    false,
        trialEndsAt:          null,
        currentPeriodEnd:     null,
      });
      break;
    }

    default:
      break;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Resolve businessId from a subscription object (metadata → local DB fallback). */
async function resolveBusinessId(sub) {
  if (sub.metadata?.businessId) return sub.metadata.businessId;
  const business = await Business.findOne({ stripeSubscriptionId: sub.id }).select('_id').lean();
  return business?._id?.toString() ?? null;
}

/** Resolve businessId from an invoice object. */
async function resolveBusinessIdFromInvoice(invoice) {
  // Try subscription metadata first
  if (invoice.subscription) {
    const business = await Business.findOne({ stripeSubscriptionId: invoice.subscription }).select('_id').lean();
    if (business) return business._id.toString();
  }
  // Try customer
  if (invoice.customer) {
    const business = await Business.findOne({ stripeCustomerId: invoice.customer }).select('_id').lean();
    if (business) return business._id.toString();
  }
  return null;
}
