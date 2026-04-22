const Business      = require('../models/Business');
const Reservation   = require('../models/Reservation');
const stripeService = require('../services/stripe');
const { getEffectivePlan, checkReservationLimit } = require('../lib/planCapabilities');

// ── POST /api/stripe/checkout ──────────────────────────────────────────────
// Creates a Stripe Checkout session with 14-day trial and returns the redirect URL.
exports.createCheckoutSession = async (req, res) => {
  try {
    const bodyPriceId = req.body?.priceId;
    const priceId = bodyPriceId || process.env.STRIPE_PRICE_BASIC;
    if (!priceId) {
      return res.status(400).json({
        message: 'No hay precio configurado para Basic. Define STRIPE_PRICE_BASIC en backend.',
      });
    }

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

// ── GET /api/stripe/connect/status ────────────────────────────────────────
// Devuelve el estado de la cuenta Connect y la config de pagos del restaurante.
exports.getConnectStatus = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId)
      .select('stripeConnectId stripeConnectEnabled reservationPayment');
    if (!business) return res.status(404).json({ message: 'Business not found' });

    res.json({
      connected:      !!business.stripeConnectId,
      stripeConnectId: business.stripeConnectId,
      reservationPayment: business.reservationPayment ?? {},
    });
  } catch (err) {
    console.error('[stripe connect status]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/stripe/connect/onboarding-url ───────────────────────────────
// Crea (o reutiliza) la cuenta Connect del restaurante y devuelve la URL de onboarding.
exports.getConnectOnboardingUrl = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId)
      .select('stripeConnectId stripeConnectEnabled email name');
    if (!business) return res.status(404).json({ message: 'Business not found' });

    let stripeConnectId = business.stripeConnectId;

    // Si no tiene cuenta aún, la creamos
    if (!stripeConnectId) {
      const account = await stripeService.createConnectAccount({
        businessId: req.businessId,
        email:      business.email,
      });
      stripeConnectId = account.id;
      await Business.findByIdAndUpdate(req.businessId, {
        stripeConnectId,
        stripeConnectEnabled: false, // se pondrá a true cuando complete el onboarding
      });
    }

    const refreshUrl = `${process.env.FRONTEND_URL}/configuracion?tab=pagos&connect=refresh`;
    const returnUrl  = `${process.env.BACKEND_URL}/api/stripe/connect/callback?businessId=${req.businessId}`;

    const accountLink = await stripeService.createAccountLink({
      stripeConnectId,
      refreshUrl,
      returnUrl,
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error('[stripe connect onboarding-url]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/stripe/connect/callback ──────────────────────────────────────
// Stripe redirige aquí cuando el restaurante termina el onboarding.
exports.handleConnectCallback = async (req, res) => {
  const { businessId } = req.query;

  if (!businessId) {
    return res.redirect(`${process.env.FRONTEND_URL}/configuracion?tab=pagos&connect=error`);
  }

  try {
    const business = await Business.findById(businessId).select('stripeConnectId');
    if (!business?.stripeConnectId) {
      return res.redirect(`${process.env.FRONTEND_URL}/configuracion?tab=pagos&connect=error`);
    }

    // Verificar que la cuenta tiene pagos y transferencias habilitados
    const account = await stripeService.getConnectAccount(business.stripeConnectId);
    const enabled = account.charges_enabled && account.payouts_enabled;

    await Business.findByIdAndUpdate(businessId, {
      stripeConnectEnabled: enabled,
    });

    const status = enabled ? 'success' : 'pending';
    res.redirect(`${process.env.FRONTEND_URL}/configuracion?tab=pagos&connect=${status}`);
  } catch (err) {
    console.error('[stripe connect callback]', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/configuracion?tab=pagos&connect=error`);
  }
};

// ── DELETE /api/stripe/connect ────────────────────────────────────────────
// Desconecta la cuenta Stripe Connect del restaurante.
exports.disconnectConnect = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select('stripeConnectId');
    if (!business?.stripeConnectId) {
      return res.status(400).json({ message: 'No hay cuenta Stripe conectada' });
    }

    try {
      await stripeService.deleteConnectAccount(business.stripeConnectId);
    } catch (err) {
      // Si ya está eliminada en Stripe, continuamos igualmente
      console.warn('[stripe connect disconnect] delete failed:', err.message);
    }

    await Business.findByIdAndUpdate(req.businessId, {
      stripeConnectId:           null,
      stripeConnectEnabled:      false,
      'reservationPayment.mode': 'none',
    });

    res.json({ message: 'Cuenta Stripe desconectada' });
  } catch (err) {
    console.error('[stripe connect disconnect]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /api/stripe/connect/payment-settings ──────────────────────────────
// Guarda la configuración de pagos en reservas del restaurante.
exports.updatePaymentSettings = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select('stripeConnectId');
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const {
      mode,
      depositAmount,
      depositPerPerson,
      noShowFeeAmount,
      freeCancellationHours,
      currency,
    } = req.body;

    // Si activan un modo de pago, deben tener cuenta Connect
    if (mode && mode !== 'none' && !business.stripeConnectId) {
      return res.status(400).json({
        message: 'Debes conectar tu cuenta Stripe antes de activar pagos en reservas',
      });
    }

    const update = {};
    if (mode                !== undefined) update['reservationPayment.mode']                = mode;
    if (depositAmount       !== undefined) update['reservationPayment.depositAmount']       = Math.round(depositAmount * 100); // €→céntimos
    if (depositPerPerson    !== undefined) update['reservationPayment.depositPerPerson']    = depositPerPerson;
    if (noShowFeeAmount     !== undefined) update['reservationPayment.noShowFeeAmount']     = Math.round(noShowFeeAmount * 100);
    if (freeCancellationHours !== undefined) update['reservationPayment.freeCancellationHours'] = freeCancellationHours;
    if (currency            !== undefined) update['reservationPayment.currency']            = currency;

    const updated = await Business.findByIdAndUpdate(req.businessId, update, { new: true })
      .select('reservationPayment stripeConnectId stripeConnectEnabled');

    res.json({ reservationPayment: updated.reservationPayment });
  } catch (err) {
    console.error('[stripe payment-settings]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── Event handlers ─────────────────────────────────────────────────────────

async function handleEvent(event) {
  const log = (msg) => console.log(`[stripe webhook] ${event.type} — ${msg}`);

  // ── Connect account events ─────────────────────────────────────────────────
  // Stripe envía eventos de cuentas Connect con event.account = stripeConnectId
  const stripeConnectId = event.account || null;

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

    // ── Pago de reserva confirmado (depósito) ──────────────────────────────
    // Stripe lo envía desde la cuenta Connect → event.account = stripeConnectId
    case 'payment_intent.succeeded': {
      if (!stripeConnectId) break; // Solo nos interesan los de cuentas Connect
      const pi = event.data.object;
      const reservation = await Reservation.findOne({
        'payment.stripePaymentIntentId': pi.id,
      });
      if (!reservation) break;
      // Solo actualizamos si aún no está marcado como capturado (por si el webhook
      // llega después de que el controller ya lo marcó sincronamente)
      if (reservation.payment?.status !== 'captured') {
        reservation.payment.status    = 'captured';
        reservation.payment.capturedAt = new Date();
        await reservation.save();
        log(`reservationId=${reservation._id} deposit confirmed`);
      }
      break;
    }

    // ── Pago de reserva fallido ────────────────────────────────────────────
    case 'payment_intent.payment_failed': {
      if (!stripeConnectId) break;
      const pi = event.data.object;
      const reservation = await Reservation.findOne({
        'payment.stripePaymentIntentId': pi.id,
      });
      if (!reservation) break;
      reservation.payment.status = 'failed';
      await reservation.save();
      log(`reservationId=${reservation._id} payment failed: ${pi.last_payment_error?.message}`);
      break;
    }

    // ── Reembolso ejecutado en Stripe (manual desde dashboard Stripe) ──────
    case 'charge.refunded': {
      if (!stripeConnectId) break;
      const charge = event.data.object;
      if (!charge.payment_intent) break;
      const reservation = await Reservation.findOne({
        'payment.stripePaymentIntentId': charge.payment_intent,
      });
      if (!reservation) break;
      if (reservation.payment?.status !== 'refunded') {
        reservation.payment.status    = 'refunded';
        reservation.payment.refundedAt = new Date();
        await reservation.save();
        log(`reservationId=${reservation._id} refunded via Stripe dashboard`);
      }
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
