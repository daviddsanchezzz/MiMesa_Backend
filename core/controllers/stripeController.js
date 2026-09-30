const { inTrial, TRIAL_DAYS } = require('../lib/planCapabilities');
const Business = require('../models/Business');
const Reservation = require('../../verticals/restaurant/models/Reservation');
const StripeEvent = require('../models/StripeEvent');
const stripeService = require('../services/stripe');
const { getEffectivePlan } = require('../lib/planCapabilities');
const { checkReservationLimit } = require('../../verticals/restaurant/lib/reservationLimits');

exports.createCheckoutSession = async (req, res) => {
  try {
    const planMap = { basic: process.env.STRIPE_PRICE_BASIC, pro: process.env.STRIPE_PRICE_PRO };
    const requestedPlan = req.body?.plan ?? 'basic';
    if (!Object.prototype.hasOwnProperty.call(planMap, requestedPlan)) {
      return res.status(400).json({ message: 'Plan invalido' });
    }
    const priceId = planMap[requestedPlan];
    if (!priceId) {
      return res.status(400).json({
        message: 'No hay precio configurado. Define STRIPE_PRICE_BASIC en backend.',
      });
    }

    const business = await Business.findById(req.businessId);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    if (business.stripeSubscriptionId && ['active', 'trialing'].includes(business.subscriptionStatus)) {
      return res.status(400).json({ message: 'Ya tienes una suscripcion activa' });
    }

    // Trial: the rest of Vetra's own trial; businesses from before the trial model
    // that never paid get the 14 days they always had; everyone else pays now.
    let trialEnd = null;
    if (!business.stripeSubscriptionId && inTrial(business)) trialEnd = business.trialEndsAt;
    else if (business.legacyAccess && !business.currentPeriodEnd) trialEnd = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const customerId = await stripeService.getOrCreateCustomer(business);
    const session = await stripeService.createCheckoutSession({
      customerId,
      priceId,
      trialEnd,
      businessId: business._id,
      successUrl: `${process.env.FRONTEND_URL}/configuracion?tab=suscripcion&subscription=success`,
      cancelUrl: `${process.env.FRONTEND_URL}/configuracion?tab=suscripcion&subscription=canceled`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe checkout]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.createPortalSession = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId);
    if (!business?.stripeCustomerId) {
      return res.status(400).json({ message: 'No hay suscripcion activa' });
    }

    const session = await stripeService.createPortalSession({
      customerId: business.stripeCustomerId,
      returnUrl: `${process.env.FRONTEND_URL}/configuracion?tab=suscripcion`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe portal]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.cancelSubscription = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId);
    if (!business?.stripeSubscriptionId) {
      return res.status(400).json({ message: 'No hay suscripcion activa' });
    }
    if (business.cancelAtPeriodEnd) {
      return res.status(400).json({ message: 'La suscripcion ya esta programada para cancelarse' });
    }

    const subscription = await stripeService.cancelSubscriptionAtPeriodEnd(business.stripeSubscriptionId);
    await Business.findByIdAndUpdate(req.businessId, {
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? true,
      currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
      trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      subscriptionStatus: subscription.status || business.subscriptionStatus,
    });

    return res.json({ message: 'Suscripcion programada para cancelar al final del periodo' });
  } catch (err) {
    console.error('[stripe cancel]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.reactivateSubscription = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId);
    if (!business?.stripeSubscriptionId) {
      return res.status(400).json({ message: 'No hay suscripcion activa' });
    }
    if (!business.cancelAtPeriodEnd) {
      return res.status(400).json({ message: 'La suscripcion no esta pendiente de cancelacion' });
    }

    const subscription = await stripeService.reactivateSubscription(business.stripeSubscriptionId);
    await Business.findByIdAndUpdate(req.businessId, {
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
      trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      subscriptionStatus: subscription.status || business.subscriptionStatus,
    });

    return res.json({ message: 'Suscripcion reactivada' });
  } catch (err) {
    console.error('[stripe reactivate]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.changePlan = async (req, res) => {
  try {
    const { plan } = req.body;
    const planMap = { basic: process.env.STRIPE_PRICE_BASIC, pro: process.env.STRIPE_PRICE_PRO };
    const newPriceId = planMap[plan];
    if (!newPriceId) return res.status(400).json({ message: 'Plan invalido' });

    const business = await Business.findById(req.businessId);
    if (!business?.stripeSubscriptionId) {
      return res.status(400).json({ message: 'No hay suscripcion activa' });
    }
    if (!['active', 'trialing'].includes(business.subscriptionStatus)) {
      return res.status(400).json({ message: 'No hay suscripcion activa para cambiar' });
    }
    if (business.plan === plan) {
      return res.status(400).json({ message: 'Ya estas en ese plan' });
    }

    const isTrialing = business.subscriptionStatus === 'trialing';
    const isUpgrade = plan === 'pro';
    const prorationBehavior = isTrialing ? 'none' : (isUpgrade ? 'always_invoice' : 'none');

    await stripeService.changePlan(business.stripeSubscriptionId, newPriceId, { prorationBehavior });
    await Business.findByIdAndUpdate(req.businessId, { plan });

    return res.json({ message: 'Plan actualizado' });
  } catch (err) {
    console.error('[stripe change-plan]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.getBillingStatus = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId)
      .select('plan subscriptionStatus legacyAccess paymentFailedAt trialEndsAt currentPeriodStart currentPeriodEnd cancelAtPeriodEnd stripeCustomerId stripeSubscriptionId');
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const effectivePlan = getEffectivePlan(business);
    const limitResult = await checkReservationLimit(req.businessId, business);

    return res.json({
      plan: effectivePlan,
      subscriptionStatus: business.subscriptionStatus,
      trialEndsAt: business.trialEndsAt,
      currentPeriodStart: business.currentPeriodStart,
      currentPeriodEnd: business.currentPeriodEnd,
      cancelAtPeriodEnd: business.cancelAtPeriodEnd,
      hasStripeCustomer: !!business.stripeCustomerId,
      usage: {
        reservations: {
          used: limitResult.used ?? 0,
          limit: limitResult.limit ?? null,
        },
      },
    });
  } catch (err) {
    console.error('[stripe status]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.getPaymentSettings = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select('reservationPayment');
    if (!business) return res.status(404).json({ message: 'Business not found' });
    return res.json({
      reservationPayment: business.reservationPayment || {},
      stripeConfig: {
        secretKeyConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
        webhookSecretConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
        currency: (process.env.STRIPE_CURRENCY || 'eur').toLowerCase(),
      },
    });
  } catch (err) {
    console.error('[stripe payment-settings]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.handleWebhook = async (req, res) => {
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error('[stripe webhook] Invalid signature:', err.message);
    return res.status(400).json({ message: `Webhook error: ${err.message}` });
  }

  try {
    if (await StripeEvent.exists({ eventId: event.id })) {
      return res.json({ received: true, duplicate: true });
    }

    await handleEvent(event);

    await StripeEvent.create({ eventId: event.id, type: event.type }).catch((err) => {
      if (err?.code !== 11000) throw err;
    });
  } catch (err) {
    // A non-2xx response makes Stripe retry, so a transient failure can't leave billing state out of sync.
    console.error('[stripe webhook] Handler error:', err.message, '| event:', event.type, event.id);
    return res.status(500).json({ message: 'Webhook handler failed' });
  }

  return res.json({ received: true });
};

// Applies a billing update unless a newer Stripe event has already been applied to this business.
async function applyBillingUpdate(businessId, update, event) {
  const eventAt = new Date((event.created || 0) * 1000);
  await Business.findOneAndUpdate(
    {
      _id: businessId,
      $or: [{ stripeEventAt: null }, { stripeEventAt: { $exists: false } }, { stripeEventAt: { $lte: eventAt } }],
    },
    { ...update, stripeEventAt: eventAt },
  );
}

async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const businessId = session.metadata?.businessId;
      if (!businessId || session.mode !== 'subscription') break;

      await Business.findByIdAndUpdate(businessId, {
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
      });
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const businessId = await resolveBusinessId(subscription);
      if (!businessId) break;

      const priceId = subscription.items?.data?.[0]?.price?.id;
      const plan = stripeService.planFromPriceId(priceId);
      const update = {
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
        trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      };

      if (subscription.current_period_end) {
        update.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
      }
      if (subscription.current_period_start) {
        update.currentPeriodStart = new Date(subscription.current_period_start * 1000);
      }
      if (['active', 'trialing'].includes(subscription.status)) {
        update.plan = plan;
        update.paymentFailedAt = null;
      }

      await applyBillingUpdate(businessId, update, event);
      break;
    }

    case 'invoice.paid': {
      const invoice = event.data.object;
      if (!invoice.subscription) break;

      const businessId = await resolveBusinessIdFromInvoice(invoice);
      if (!businessId) break;

      const subscriptionLine = invoice.lines?.data?.find((line) => line.type === 'subscription');
      const priceId = subscriptionLine?.price?.id ?? invoice.lines?.data?.[0]?.price?.id;
      const plan = stripeService.planFromPriceId(priceId);

      const update = { subscriptionStatus: 'active', plan, paymentFailedAt: null };
      if (subscriptionLine?.period?.end) {
        update.currentPeriodEnd = new Date(subscriptionLine.period.end * 1000);
        update.currentPeriodStart = new Date((subscriptionLine.period.start ?? invoice.period_start) * 1000);
      }

      await applyBillingUpdate(businessId, update, event);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      if (!invoice.subscription) break;

      const businessId = await resolveBusinessIdFromInvoice(invoice);
      if (!businessId) break;

      await applyBillingUpdate(businessId, { subscriptionStatus: 'past_due' }, event);
      // Start of an unpaid episode: remember when, and tell the owner once.
      const first = await Business.findOneAndUpdate(
        { _id: businessId, paymentFailedAt: null }, { $set: { paymentFailedAt: new Date() } }, { new: true },
      ).lean();
      if (first) {
        require('../services/billingEmails').sendPaymentFailed(first, invoice)
          .catch((err) => console.error('[stripe] payment failed email:', err.message));
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const businessId = await resolveBusinessId(subscription);
      if (!businessId) break;

      await applyBillingUpdate(businessId, {
        subscriptionStatus: 'canceled',
        plan: 'free',
        stripeSubscriptionId: null,
        cancelAtPeriodEnd: false,
        trialEndsAt: null,
        currentPeriodEnd: null,
        paymentFailedAt: null,
      }, event);
      break;
    }

    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;
      const reservation = await findReservationForPaymentIntent(paymentIntent);
      if (!reservation) break;

      reservation.payment.paymentStatus = 'paid';
      reservation.payment.status = 'captured';
      reservation.payment.paidAt = new Date();
      reservation.payment.capturedAt = new Date();
      reservation.payment.stripePaymentIntentId = paymentIntent.id;
      if (reservation.status === 'pending') {
        reservation.status = 'confirmed';
      }
      await reservation.save();
      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;
      const reservation = await findReservationForPaymentIntent(paymentIntent);
      if (!reservation) break;

      reservation.payment.paymentStatus = 'failed';
      reservation.payment.status = 'failed';
      reservation.payment.stripePaymentIntentId = paymentIntent.id;
      await reservation.save();
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object;
      if (!charge.payment_intent) break;

      const reservation = await Reservation.findOne({
        'payment.stripePaymentIntentId': charge.payment_intent,
      });
      if (!reservation) break;

      reservation.payment.paymentStatus = 'refunded';
      reservation.payment.status = 'refunded';
      reservation.payment.refundedAt = new Date();
      await reservation.save();
      break;
    }

    default:
      break;
  }
}

async function findReservationForPaymentIntent(paymentIntent) {
  const reservationId = paymentIntent.metadata?.reservationId;
  if (reservationId) {
    const byMetadata = await Reservation.findById(reservationId);
    if (byMetadata) return byMetadata;
  }
  return Reservation.findOne({ 'payment.stripePaymentIntentId': paymentIntent.id });
}

async function resolveBusinessId(subscription) {
  if (subscription.metadata?.businessId) return subscription.metadata.businessId;
  const business = await Business.findOne({ stripeSubscriptionId: subscription.id }).select('_id').lean();
  return business?._id?.toString() ?? null;
}

async function resolveBusinessIdFromInvoice(invoice) {
  if (invoice.subscription) {
    const business = await Business.findOne({ stripeSubscriptionId: invoice.subscription }).select('_id').lean();
    if (business) return business._id.toString();
  }
  if (invoice.customer) {
    const business = await Business.findOne({ stripeCustomerId: invoice.customer }).select('_id').lean();
    if (business) return business._id.toString();
  }
  return null;
}
