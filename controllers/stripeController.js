const Business = require('../models/Business');
const Reservation = require('../models/Reservation');
const stripeService = require('../services/stripe');
const { getEffectivePlan, checkReservationLimit } = require('../lib/planCapabilities');

exports.createCheckoutSession = async (req, res) => {
  try {
    const planMap = { basic: process.env.STRIPE_PRICE_BASIC, pro: process.env.STRIPE_PRICE_PRO };
    const priceId = planMap[req.body?.plan] || req.body?.priceId || process.env.STRIPE_PRICE_BASIC;
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

    const customerId = await stripeService.getOrCreateCustomer(business);
    const session = await stripeService.createCheckoutSession({
      customerId,
      priceId,
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
      .select('plan subscriptionStatus trialEndsAt currentPeriodStart currentPeriodEnd cancelAtPeriodEnd stripeCustomerId stripeSubscriptionId');
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
    await handleEvent(event);
  } catch (err) {
    console.error('[stripe webhook] Handler error:', err.message, '| event:', event.type);
  }

  return res.json({ received: true });
};

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
      }

      await Business.findByIdAndUpdate(businessId, update);
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

      const update = { subscriptionStatus: 'active', plan };
      if (subscriptionLine?.period?.end) {
        update.currentPeriodEnd = new Date(subscriptionLine.period.end * 1000);
        update.currentPeriodStart = new Date((subscriptionLine.period.start ?? invoice.period_start) * 1000);
      }

      await Business.findByIdAndUpdate(businessId, update);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      if (!invoice.subscription) break;

      const businessId = await resolveBusinessIdFromInvoice(invoice);
      if (!businessId) break;

      await Business.findByIdAndUpdate(businessId, { subscriptionStatus: 'past_due' });
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const businessId = await resolveBusinessId(subscription);
      if (!businessId) break;

      await Business.findByIdAndUpdate(businessId, {
        subscriptionStatus: 'canceled',
        plan: 'free',
        stripeSubscriptionId: null,
        cancelAtPeriodEnd: false,
        trialEndsAt: null,
        currentPeriodEnd: null,
      });
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
