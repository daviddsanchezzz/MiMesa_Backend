const Business = require('../models/Business');
const Reservation = require('../models/Reservation');
const stripe = require('../services/stripe');

function getReservationPaymentConfig(business) {
  const reservationPayment = business?.reservationPayment || {};
  const mode = reservationPayment.mode === 'deposit' ? 'deposit' : 'none';
  const currency = (reservationPayment.currency || stripe.getCurrency()).toLowerCase();

  return {
    enabled: Boolean(reservationPayment.enabled && mode === 'deposit'),
    mode,
    currency,
    depositAmount: reservationPayment.depositAmount || 0,
    depositPerPerson: Boolean(reservationPayment.depositPerPerson),
    freeCancellationHours: reservationPayment.freeCancellationHours ?? 24,
  };
}

function calculateDepositAmount({ paymentConfig, people }) {
  if (!paymentConfig.enabled || paymentConfig.mode !== 'deposit') return 0;
  const partySize = Math.max(parseInt(people, 10) || 1, 1);
  return paymentConfig.depositPerPerson
    ? paymentConfig.depositAmount * partySize
    : paymentConfig.depositAmount;
}

function buildPaymentSnapshot({ paymentConfig, amount, status = 'unpaid', paymentIntentId = null }) {
  const depositMode = !paymentConfig.enabled
    ? 'none'
    : (paymentConfig.depositPerPerson ? 'per_person' : 'fixed');

  const legacyStatusMap = {
    unpaid: 'none',
    pending: 'pending',
    paid: 'captured',
    failed: 'failed',
    refunded: 'refunded',
  };

  return {
    paymentStatus: status,
    stripePaymentIntentId: paymentIntentId,
    depositAmount: amount,
    depositCurrency: paymentConfig.currency,
    depositMode,
    paidAt: status === 'paid' ? new Date() : null,
    refundedAt: null,
    mode: paymentConfig.enabled ? 'deposit' : 'none',
    status: legacyStatusMap[status] || 'none',
    amount,
    currency: paymentConfig.currency,
    capturedAt: status === 'paid' ? new Date() : null,
  };
}

exports.getPublicPaymentConfig = async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ message: 'businessId requerido' });

    const business = await Business.findById(businessId).select('reservationPayment');
    if (!business) return res.status(404).json({ message: 'Restaurante no encontrado' });

    const paymentConfig = getReservationPaymentConfig(business);
    if (!paymentConfig.enabled) return res.json({ mode: 'none' });

    return res.json({
      mode: 'deposit',
      currency: paymentConfig.currency,
      depositAmount: paymentConfig.depositAmount,
      depositPerPerson: paymentConfig.depositPerPerson,
      freeCancellationHours: paymentConfig.freeCancellationHours,
    });
  } catch (err) {
    console.error('[payment-config]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.createPublicPaymentIntent = async (req, res) => {
  try {
    const { businessId, people } = req.body;
    if (!businessId) return res.status(400).json({ message: 'businessId requerido' });

    const business = await Business.findById(businessId).select('reservationPayment');
    if (!business) return res.status(404).json({ message: 'Restaurante no encontrado' });

    const paymentConfig = getReservationPaymentConfig(business);
    const amount = calculateDepositAmount({ paymentConfig, people });
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Este restaurante no requiere deposito' });
    }

    const paymentIntent = await stripe.createReservationPaymentIntent({
      amount,
      currency: paymentConfig.currency,
      metadata: {
        businessId: businessId.toString(),
      },
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount,
      currency: paymentConfig.currency,
    });
  } catch (err) {
    console.error('[public-payment-intent]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.createReservationPaymentIntent = async (req, res) => {
  try {
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) return res.status(404).json({ message: 'Reserva no encontrada' });

    if (reservation.payment?.paymentStatus === 'paid') {
      return res.status(400).json({ message: 'La reserva ya tiene el deposito pagado' });
    }

    const business = await Business.findById(reservation.businessId).select('reservationPayment');
    if (!business) return res.status(404).json({ message: 'Restaurante no encontrado' });

    const paymentConfig = getReservationPaymentConfig(business);
    const amount = calculateDepositAmount({ paymentConfig, people: reservation.people });
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Esta reserva no requiere deposito' });
    }

    const paymentIntent = await stripe.createReservationPaymentIntent({
      amount,
      currency: paymentConfig.currency,
      metadata: {
        reservationId: reservation._id.toString(),
        businessId: reservation.businessId.toString(),
        customerName: reservation.guestName || '',
      },
    });

    reservation.payment = {
      ...(reservation.payment?.toObject ? reservation.payment.toObject() : reservation.payment),
      ...buildPaymentSnapshot({
        paymentConfig,
        amount,
        status: 'pending',
        paymentIntentId: paymentIntent.id,
      }),
    };
    await reservation.save();

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount,
      currency: paymentConfig.currency,
    });
  } catch (err) {
    console.error('[create-payment-intent]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.updatePaymentSettings = async (req, res) => {
  try {
    const mode = req.body?.mode === 'deposit' ? 'deposit' : 'none';
    const enabled = mode === 'deposit';
    const depositAmount = enabled ? Math.round((Number(req.body?.depositAmount) || 0) * 100) : 0;
    const depositPerPerson = enabled ? Boolean(req.body?.depositPerPerson) : false;
    const freeCancellationHours = Number(req.body?.freeCancellationHours) || 24;
    const currency = (req.body?.currency || stripe.getCurrency()).toLowerCase();

    const business = await Business.findByIdAndUpdate(
      req.businessId,
      {
        reservationPayment: {
          enabled,
          mode,
          depositAmount,
          depositPerPerson,
          freeCancellationHours,
          currency,
        },
      },
      { new: true },
    ).select('reservationPayment');

    return res.json({ reservationPayment: business.reservationPayment });
  } catch (err) {
    console.error('[stripe payment-settings]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.refundDeposit = async (req, res) => {
  try {
    const reservation = await Reservation.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!reservation) return res.status(404).json({ message: 'Reserva no encontrada' });

    if (reservation.payment?.paymentStatus !== 'paid' || !reservation.payment?.stripePaymentIntentId) {
      return res.status(400).json({ message: 'No hay deposito pagado para reembolsar' });
    }

    await stripe.refundPaymentIntent({
      paymentIntentId: reservation.payment.stripePaymentIntentId,
    });

    reservation.payment.paymentStatus = 'refunded';
    reservation.payment.status = 'refunded';
    reservation.payment.refundedAt = new Date();
    await reservation.save();

    return res.json(reservation);
  } catch (err) {
    console.error('[refund-deposit]', err.message);
    return res.status(500).json({ message: err.message });
  }
};

module.exports.getReservationPaymentConfig = getReservationPaymentConfig;
module.exports.calculateDepositAmount = calculateDepositAmount;
module.exports.buildPaymentSnapshot = buildPaymentSnapshot;
