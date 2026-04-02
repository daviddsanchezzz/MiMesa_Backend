/**
 * reservationPaymentController.js
 *
 * Endpoints relacionados con los pagos en reservas:
 *   - Crear PaymentIntent / SetupIntent (flujo público del widget)
 *   - Obtener config de pago pública
 *   - Cobrar no-show (autenticado, restaurante)
 *   - Reembolsar depósito (autenticado, restaurante)
 */

const Business   = require('../models/Business');
const Reservation = require('../models/Reservation');
const Customer   = require('../models/Customer');
const stripe     = require('../services/stripe');

const POPULATE = [
  { path: 'customerId', select: 'name phone email visits noShowCount' },
  { path: 'tableId',  select: 'name capacity roomId', populate: { path: 'roomId', select: 'name' } },
  { path: 'tableIds', select: 'name capacity roomId', populate: { path: 'roomId', select: 'name' } },
  { path: 'roomId', select: 'name' },
];

// ── GET /api/reservations/public/payment-config?businessId=xxx ──────────────
// Devuelve la configuración de pagos pública para el widget de reserva.
exports.getPublicPaymentConfig = async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ message: 'businessId requerido' });

    const business = await Business.findById(businessId)
      .select('stripeConnectId stripeConnectEnabled reservationPayment');
    if (!business) return res.status(404).json({ message: 'Restaurante no encontrado' });

    const rp = business.reservationPayment || {};

    // Si no hay cuenta Connect o el modo es 'none', devolvemos sin pago
    if (!business.stripeConnectId || rp.mode === 'none' || !rp.mode) {
      return res.json({ mode: 'none' });
    }

    res.json({
      mode:                  rp.mode,
      depositAmount:         rp.depositAmount   ?? 0,   // céntimos
      depositPerPerson:      rp.depositPerPerson ?? false,
      noShowFeeAmount:       rp.noShowFeeAmount  ?? 0,
      freeCancellationHours: rp.freeCancellationHours ?? 24,
      currency:              rp.currency ?? 'eur',
      // Necesario para inicializar Stripe.js con la cuenta Connect correcta
      stripeConnectId:       business.stripeConnectId,
    });
  } catch (err) {
    console.error('[payment-config]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/reservations/public/payment-intent ────────────────────────────
// Crea un PaymentIntent en la cuenta Connect del restaurante (modo depósito).
// El frontend confirma el pago con Stripe Elements y luego llama a /public (crear reserva).
exports.createPublicPaymentIntent = async (req, res) => {
  try {
    const { businessId, people } = req.body;
    if (!businessId) return res.status(400).json({ message: 'businessId requerido' });

    const business = await Business.findById(businessId)
      .select('stripeConnectId reservationPayment');
    if (!business?.stripeConnectId) {
      return res.status(400).json({ message: 'Este restaurante no tiene pagos configurados' });
    }

    const rp = business.reservationPayment;
    if (rp.mode !== 'deposit') {
      return res.status(400).json({ message: 'El modo de pago no es depósito' });
    }

    // Calcular importe: fijo o por persona
    const numPeople = parseInt(people, 10) || 1;
    const amount = rp.depositPerPerson
      ? rp.depositAmount * numPeople
      : rp.depositAmount;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Importe de depósito no configurado' });
    }

    const intent = await stripe.createReservationPaymentIntent({
      stripeConnectId: business.stripeConnectId,
      amount,
      currency: rp.currency ?? 'eur',
      metadata: { businessId: businessId.toString() },
    });

    res.json({
      clientSecret: intent.client_secret,
      amount,
      currency: rp.currency ?? 'eur',
    });
  } catch (err) {
    console.error('[payment-intent]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/reservations/public/setup-intent ──────────────────────────────
// Crea un SetupIntent en la cuenta Connect del restaurante (modo garantía).
// El frontend confirma el SetupIntent y obtiene el paymentMethodId para pasarlo al crear la reserva.
exports.createPublicSetupIntent = async (req, res) => {
  try {
    const { businessId } = req.body;
    if (!businessId) return res.status(400).json({ message: 'businessId requerido' });

    const business = await Business.findById(businessId)
      .select('stripeConnectId reservationPayment');
    if (!business?.stripeConnectId) {
      return res.status(400).json({ message: 'Este restaurante no tiene pagos configurados' });
    }

    const rp = business.reservationPayment;
    if (rp.mode !== 'card_guarantee') {
      return res.status(400).json({ message: 'El modo de pago no es garantía con tarjeta' });
    }

    const intent = await stripe.createReservationSetupIntent({
      stripeConnectId: business.stripeConnectId,
      metadata: { businessId: businessId.toString() },
    });

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error('[setup-intent]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/reservations/:id/charge-noshow ────────────────────────────────
// Cobra la tarjeta guardada de un huésped que no asistió (modo garantía).
// Solo disponible si la reserva tiene tarjeta guardada (payment.mode = 'card_guarantee').
exports.chargeNoShow = async (req, res) => {
  try {
    const reservation = await Reservation.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!reservation) return res.status(404).json({ message: 'Reserva no encontrada' });

    if (!['confirmed', 'seated'].includes(reservation.status)) {
      return res.status(400).json({ message: 'Solo se puede cobrar no-show a reservas confirmadas o sentadas' });
    }

    if (reservation.payment?.mode !== 'card_guarantee') {
      return res.status(400).json({ message: 'Esta reserva no tiene tarjeta de garantía' });
    }

    if (reservation.payment?.status === 'captured') {
      return res.status(400).json({ message: 'El no-show ya fue cobrado' });
    }

    const { stripePaymentMethodId, stripeCustomerId, noShowFeeAmount, currency } = reservation.payment;
    if (!stripePaymentMethodId || !stripeCustomerId) {
      return res.status(400).json({ message: 'Datos de tarjeta no disponibles' });
    }

    const business = await Business.findById(req.businessId)
      .select('stripeConnectId reservationPayment plan subscriptionStatus');

    const amount = reservation.payment.amount || business.reservationPayment?.noShowFeeAmount || 0;
    if (!amount) return res.status(400).json({ message: 'Importe de no-show no configurado' });

    const intent = await stripe.chargeNoShow({
      stripeConnectId:  business.stripeConnectId,
      paymentMethodId:  stripePaymentMethodId,
      customerId:       stripeCustomerId,
      amount,
      currency:         currency || 'eur',
      metadata: {
        reservationId: reservation._id.toString(),
        businessId:    req.businessId.toString(),
      },
    });

    reservation.status = 'no_show';
    reservation.payment.status = 'captured';
    reservation.payment.stripePaymentIntentId = intent.id;
    reservation.payment.capturedAt = new Date();
    await reservation.save();

    if (reservation.customerId) {
      await Customer.findByIdAndUpdate(reservation.customerId, { $inc: { noShowCount: 1 } });
    }

    res.json(await reservation.populate(POPULATE));
  } catch (err) {
    console.error('[charge-noshow]', err.message);
    // Si Stripe rechaza el cobro (tarjeta caducada, etc.)
    if (err.type?.startsWith('Stripe')) {
      return res.status(402).json({ message: `Cobro rechazado: ${err.message}` });
    }
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/reservations/:id/refund ───────────────────────────────────────
// Reembolsa el depósito de una reserva (modo depósito).
exports.refundDeposit = async (req, res) => {
  try {
    const reservation = await Reservation.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!reservation) return res.status(404).json({ message: 'Reserva no encontrada' });

    if (reservation.payment?.mode !== 'deposit') {
      return res.status(400).json({ message: 'Esta reserva no tiene depósito' });
    }
    if (!reservation.payment?.stripePaymentIntentId) {
      return res.status(400).json({ message: 'No hay PaymentIntent asociado' });
    }
    if (reservation.payment?.status === 'refunded') {
      return res.status(400).json({ message: 'El depósito ya fue reembolsado' });
    }
    if (reservation.payment?.status !== 'captured') {
      return res.status(400).json({ message: 'El depósito no está en estado cobrado' });
    }

    const business = await Business.findById(req.businessId).select('stripeConnectId');

    await stripe.refundPaymentIntent({
      stripeConnectId:  business.stripeConnectId,
      paymentIntentId:  reservation.payment.stripePaymentIntentId,
    });

    reservation.payment.status = 'refunded';
    reservation.payment.refundedAt = new Date();
    await reservation.save();

    res.json(await reservation.populate(POPULATE));
  } catch (err) {
    console.error('[refund-deposit]', err.message);
    res.status(500).json({ message: err.message });
  }
};
