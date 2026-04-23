const Reservation = require('../models/Reservation');
const Customer = require('../models/Customer');
const Table = require('../models/Table');
const Shift = require('../models/Shift');
const Vacation = require('../models/Vacation');
const Business = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');
const Exception = require('../models/Exception');
const stripeService = require('../services/stripe');
const {
  sendReservationConfirmation,
  sendStatusUpdate,
  sendStaffReservationNotification,
  sendPendingApprovalStaffNotification,
  sendReservationPendingEmail,
  sendAlternativeProposalEmail,
} = require('../services/email');
const { canUseFeature, checkReservationLimit } = require('../lib/planCapabilities');
const { getPhoneMatchCandidates, toStoredNormalizedPhone } = require('../lib/phoneMatching');

const POPULATE = [
  { path: 'customerId', select: 'name phone email visits noShowCount cancellationCount' },
  { path: 'tableId',  select: 'name capacity roomId', populate: { path: 'roomId', select: 'name' } },
  { path: 'tableIds', select: 'name capacity roomId', populate: { path: 'roomId', select: 'name' } },
  { path: 'roomId', select: 'name' },
];
const BLOCKING_EXCEPTION_TYPES = ['closed', 'full', 'call'];

/**
 * Normaliza teléfonos para matching: elimina todo lo que no sea dígito.
 * "+34 609 626 912", "0034-609626912", "609626912" → solo dígitos.
 * No asume ningún prefijo de país concreto.
 */
function toMinutes(t) {
  const [h, m] = String(t || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function generateSlots(startTime, endTime) {
  const [sh, sm] = String(startTime || '00:00').split(':').map(Number);
  let [eh, em] = String(endTime || '00:00').split(':').map(Number);
  if (eh === 0 && em === 0) {
    eh = 24;
    em = 0;
  }
  const slots = [];
  for (let t = sh * 60 + sm; t < eh * 60 + em; t += 30) {
    const h = Math.floor(t / 60) % 24;
    const m = t % 60;
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return slots;
}

async function findOrCreateCustomer(businessId, guestName, guestPhone, guestEmail) {
  const phone    = (guestPhone || '').trim();
  const normPhone = toStoredNormalizedPhone(phone);
  const phoneCandidates = getPhoneMatchCandidates(phone);
  const email    = (guestEmail || '').trim().toLowerCase();
  const name     = (guestName || '').trim();

  if (!phone && !email) return null;

  let customer = null;
  if (email) customer = await Customer.findOne({ businessId, email });
  if (!customer && phoneCandidates.length > 0) {
    // Buscar por normalizedPhone y phone legacy con variantes de prefijo/pais
    customer = await Customer.findOne({
      businessId,
      $or: [
        { normalizedPhone: { $in: phoneCandidates } },
        { phone: { $in: [phone, ...phoneCandidates] } },
      ],
    }).sort({ createdAt: 1 });
  }

  if (!customer) {
    return Customer.create({
      businessId,
      name,
      phone,
      normalizedPhone: normPhone,
      email,
    });
  }

  const update = {};
  if (name && customer.name !== name) update.name = name;
  if (phone && customer.phone !== phone) update.phone = phone;
  if (email && customer.email !== email) update.email = email;
  // Rellenar normalizedPhone si falta (clientes legacy)
  if (normPhone && !customer.normalizedPhone) update.normalizedPhone = normPhone;
  if (Object.keys(update).length > 0) {
    await Customer.updateOne({ _id: customer._id }, { $set: update });
    customer = { ...customer.toObject(), ...update };
  }

  return customer;
}

async function notifyStaff(businessId, reservation, eventType) {
  try {
    const business = await Business.findById(businessId).select('name brandColor');
    if (!business) return;

    // Fetch customer stats if linked
    let customerStats = null;
    const customerId = reservation.customerId?._id || reservation.customerId;
    if (customerId) {
      const c = await Customer.findById(customerId).select('noShowCount cancellationCount').lean();
      if (c && (c.noShowCount > 0 || c.cancellationCount > 0)) {
        customerStats = { noShowCount: c.noShowCount || 0, cancellationCount: c.cancellationCount || 0 };
      }
    }

    const members = await BusinessMember.find({
      businessId,
      status: { $ne: 'invited' },
      userEmail: { $ne: '' },
    }).select('userEmail notificationPreferences');

    const recipients = [...new Set(
      members
        .filter((m) => {
          const prefs = m.notificationPreferences || {};
          if (eventType === 'cancelled') return prefs.cancelledReservationEmail !== false;
          return prefs.newReservationEmail !== false;
        })
        .map((m) => m.userEmail)
        .filter(Boolean)
    )];

    if (recipients.length === 0) return;
    await sendStaffReservationNotification(recipients, reservation, business, eventType, customerStats);
  } catch (err) {
    console.error('[reservations] notifyStaff failed:', err.message);
  }
}

async function notifyStaffPending(businessId, reservation) {
  try {
    const business = await Business.findById(businessId).select('name brandColor email');
    if (!business) return;

    const members = await BusinessMember.find({
      businessId,
      status: { $ne: 'invited' },
      userEmail: { $ne: '' },
    }).select('userEmail notificationPreferences role');

    const recipients = [...new Set(
      members
        .filter((m) => {
          const prefs = m.notificationPreferences || {};
          return prefs.newReservationEmail !== false;
        })
        .map((m) => m.userEmail)
        .filter(Boolean)
    )];

    if (recipients.length === 0) return;
    await sendPendingApprovalStaffNotification(recipients, reservation, business);
  } catch (err) {
    console.error('[reservations] notifyStaffPending failed:', err.message);
  }
}

async function getSlotLoad({ businessId, date, time, durationMinutes }) {
  const target = toMinutes(time);
  const reservations = await Reservation.find({
    businessId,
    date,
    status: { $in: ['confirmed', 'seated'] },
  }).select('time people');

  return reservations.reduce((sum, r) => {
    const start = toMinutes(r.time);
    if (durationMinutes === 0) {
      if (start === target) return sum + (r.people || 0);
      return sum;
    }
    if (start <= target && start + durationMinutes > target) {
      return sum + (r.people || 0);
    }
    return sum;
  }, 0);
}

async function evaluateReservationStatus({ business, businessId, date, time, people }) {
  const hasPendingControl = canUseFeature(business, 'pendingApprovalControl');
  const duration = business.reservationDuration || 0;

  const overLargeGroupThreshold =
    business.requireApprovalAbove !== null &&
    business.requireApprovalAbove !== undefined &&
    Number(people) > Number(business.requireApprovalAbove);

  let overSlotCapacity = false;
  if (business.maxPeoplePerSlot) {
    const used = await getSlotLoad({ businessId, date, time, durationMinutes: duration });
    overSlotCapacity = used + Number(people) > Number(business.maxPeoplePerSlot);
  }

  if (hasPendingControl && overLargeGroupThreshold) {
    return { status: 'pending', pendingReason: 'large_group' };
  }
  if (hasPendingControl && overSlotCapacity) {
    return { status: 'pending', pendingReason: 'slot_capacity' };
  }
  if (!hasPendingControl && overSlotCapacity) {
    return { status: 'rejected_capacity', pendingReason: 'none' };
  }
  return { status: 'confirmed', pendingReason: 'none' };
}

async function getApplicableShiftSlotsForDate(businessId, date) {
  const dayOfWeek = new Date(`${date}T12:00:00Z`).getDay();
  const allShifts = await Shift.find({ businessId, days: dayOfWeek }).sort({ startTime: 1 });
  const general = allShifts.filter((s) => !s.startDate && !s.endDate);
  const specific = allShifts.filter((s) => s.startDate && s.endDate && date >= s.startDate && date <= s.endDate);
  const byName = {};
  general.forEach((s) => { byName[s.name] = s; });
  specific.forEach((s) => { byName[s.name] = s; });
  const applicable = Object.values(byName);
  const slots = [];
  applicable.forEach((shift) => {
    const times = shift.subShifts.length
      ? shift.subShifts.map((ss) => ss.time)
      : generateSlots(shift.startTime, shift.endTime);
    times.forEach((t) => slots.push({ shiftName: shift.name, time: t }));
  });
  const unique = new Map();
  slots.forEach((s) => {
    const key = `${s.shiftName}__${s.time}`;
    if (!unique.has(key)) unique.set(key, s);
  });
  return [...unique.values()].sort((a, b) => a.time.localeCompare(b.time));
}

async function getApplicableSlotsForDate(businessId, date) {
  const withShift = await getApplicableShiftSlotsForDate(businessId, date);
  return [...new Set(withShift.map((s) => s.time))].sort();
}

async function getExceptionBlocksForShift({ businessId, date, shiftName, roomId = null }) {
  const rows = await Exception.find({ businessId, date, shiftName }).select('type roomId message').lean();
  const blocking = rows.find((r) => BLOCKING_EXCEPTION_TYPES.includes(r.type));
  if (blocking) {
    return {
      blocked: true,
      type: blocking.type,
      message: blocking.message || null,
    };
  }

  if (roomId) {
    const roomBlocked = rows.find((r) => r.type === 'close_room' && r.roomId && String(r.roomId) === String(roomId));
    if (roomBlocked) {
      return {
        blocked: true,
        type: 'close_room',
        message: roomBlocked.message || null,
      };
    }
  }

  return { blocked: false, type: null, message: null };
}

async function suggestAlternativeSlot({ business, reservation }) {
  const maxDaysAhead = 14;
  const today = new Date(`${reservation.date}T00:00:00`);
  const businessId = reservation.businessId;
  for (let i = 0; i < maxDaysAhead; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const date = d.toISOString().slice(0, 10);

    const closed = await Vacation.findOne({
      businessId,
      startDate: { $lte: date },
      endDate: { $gte: date },
    }).select('_id');
    if (closed) continue;

    const slots = await getApplicableShiftSlotsForDate(businessId, date);
    if (slots.length === 0) continue;

    for (const slot of slots) {
      const { time, shiftName } = slot;
      if (date === reservation.date && time === reservation.time) continue;

      const blocked = await getExceptionBlocksForShift({
        businessId,
        date,
        shiftName,
      });
      if (blocked.blocked) continue;

      if (!business.maxPeoplePerSlot) return { date, time };

      const used = await getSlotLoad({
        businessId,
        date,
        time,
        durationMinutes: business.reservationDuration || 0,
      });
      if (used + reservation.people <= business.maxPeoplePerSlot) {
        return { date, time };
      }
    }
  }
  return null;
}

async function updateTableStatusForReservation(reservation, businessId) {
  let tableStatus = 'reserved';
  if (reservation.status === 'seated') tableStatus = 'occupied';
  if (['cancelled', 'no_show', 'pending'].includes(reservation.status)) tableStatus = 'free';

  // Collect all assigned table IDs (tableIds array takes precedence over legacy tableId)
  const ids = new Set();
  if (Array.isArray(reservation.tableIds) && reservation.tableIds.length > 0) {
    for (const t of reservation.tableIds) {
      const id = t?._id?.toString() || t?.toString();
      if (id) ids.add(id);
    }
  } else {
    const id = reservation.tableId?._id?.toString() || reservation.tableId?.toString();
    if (id) ids.add(id);
  }
  if (ids.size === 0) return;
  await Table.updateMany({ _id: { $in: [...ids] }, businessId }, { status: tableStatus });
}

exports.getReservations = async (req, res) => {
  try {
    const filter = { businessId: req.businessId };
    if (req.query.date) filter.date = req.query.date;
    else if (req.query.from && req.query.to) filter.date = { $gte: req.query.from, $lte: req.query.to };

    // Auto-seat: transition confirmed reservations whose time has passed
    const nowDate = new Date().toISOString().slice(0, 10);
    const nowTime = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
    const toSeat = await Reservation.find({
      businessId: req.businessId,
      status: 'confirmed',
      $or: [
        { date: { $lt: nowDate } },
        { date: nowDate, time: { $lte: nowTime } },
      ],
    });
    if (toSeat.length > 0) {
      await Reservation.updateMany(
        { _id: { $in: toSeat.map(r => r._id) } },
        { status: 'seated' }
      );
      // Update table statuses
      for (const r of toSeat) {
        const ids = new Set([
          ...(r.tableIds?.map(id => id.toString()) || []),
          ...(r.tableId ? [r.tableId.toString()] : []),
        ]);
        if (ids.size > 0) {
          await Table.updateMany({ _id: { $in: [...ids] }, businessId: req.businessId }, { status: 'occupied' });
        }
      }
    }

    const reservations = await Reservation.find(filter).populate(POPULATE).sort({ date: 1, time: 1 });
    res.json(reservations);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPendingReservations = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select('plan subscriptionStatus');
    if (!canUseFeature(business, 'pendingApprovalControl')) {
      return res.status(403).json({ message: 'Esta funcion requiere plan Pro', feature: 'pendingApprovalControl', upgradeRequired: true });
    }
    const reservations = await Reservation.find({
      businessId: req.businessId,
      status: 'pending',
    }).populate(POPULATE).sort({ date: 1, time: 1, createdAt: 1 });
    res.json(reservations);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createReservation = async (req, res) => {
  try {
    const { guestName, guestPhone, guestEmail, roomId, tableId, tableIds: rawTableIds, date, time, people, notes, consent } = req.body;
    const tableIds = Array.isArray(rawTableIds) && rawTableIds.length > 0 ? rawTableIds : (tableId ? [tableId] : []);
    const primaryTableId = tableIds[0] || tableId || null;
    const business = await Business.findById(req.businessId).select(
      'name brandColor email phone plan subscriptionStatus maxPeoplePerSlot reservationDuration requireApprovalAbove'
    );
    // Dedup: reject if an identical reservation was created in the last 2 minutes
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const duplicate = await Reservation.findOne({
      businessId: req.businessId,
      date,
      time,
      people,
      guestName: { $regex: new RegExp(`^${guestName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      createdAt: { $gte: twoMinutesAgo },
    });
    if (duplicate) {
      return res.status(409).json({ message: 'Reserva duplicada. Ya existe una reserva idéntica creada hace menos de 2 minutos.' });
    }

    const limitCheck = await checkReservationLimit(req.businessId, business);
    if (!limitCheck.allowed) {
      return res.status(403).json({
        message: `Has alcanzado el limite de ${limitCheck.limit} reservas al mes del plan gratuito`,
        limitReached: true,
        upgradeRequired: true,
        used: limitCheck.used,
        limit: limitCheck.limit,
      });
    }

    const decision = await evaluateReservationStatus({
      business,
      businessId: req.businessId,
      date,
      time,
      people,
    });

    const customer = await findOrCreateCustomer(req.businessId, guestName, guestPhone, guestEmail);
    const reservation = await Reservation.create({
      businessId: req.businessId,
      customerId: customer?._id || null,
      guestName,
      guestPhone: guestPhone || '',
      guestEmail: guestEmail || '',
      roomId: roomId || null,
      tableId: primaryTableId,
      tableIds,
      date,
      time,
      people,
      notes: notes || '',
      consent: consent || false,
      status: decision.status === 'rejected_capacity' ? 'confirmed' : decision.status,
      pendingReason: decision.pendingReason,
    });

    const populated = await reservation.populate(POPULATE);
    await updateTableStatusForReservation(populated, req.businessId);

    if (canUseFeature(business, 'autoEmails') && populated.guestEmail) {
      if (populated.status === 'pending') await sendReservationPendingEmail(populated, business);
      else await sendReservationConfirmation(populated, business);
    }
    if (populated.status === 'pending') {
      await notifyStaffPending(req.businessId, populated);
    }

    const payload = populated.toObject ? populated.toObject() : populated;
    if (payload.status === 'pending') {
      payload.statusMessage = 'Reserva pendiente de aprobacion. Puedes aceptarla, rechazarla o proponer otro horario.';
    }
    return res.status(201).json(payload);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.createPublicReservation = async (req, res) => {
  try {
    const {
      businessId, guestName, guestPhone, guestEmail, roomId, tableId,
      date, time, people, notes, consent, marketingConsent, marketingConsentText, promoCode: rawPromoCode,
      // Datos de pago (opcionales — solo si el restaurante tiene pagos activos)
      paymentIntentId,    // modo depósito: ID del PaymentIntent ya confirmado
      setupIntentId,      // modo garantía: ID del SetupIntent ya confirmado
      paymentMethodId,    // modo garantía: ID del PaymentMethod guardado
    } = req.body;

    const phone = (guestPhone || '').trim();
    const email = (guestEmail || '').trim().toLowerCase();
    if (!phone) return res.status(400).json({ message: 'El telefono es obligatorio' });
    if (!email) return res.status(400).json({ message: 'El email es obligatorio' });

    const business = await Business.findById(businessId).select(
      'name brandColor maxReservationPeople maxPeoplePerSlot reservationDuration requireApprovalAbove reminderHoursBefore email phone plan subscriptionStatus stripeConnectId reservationPayment'
    );
    if (!business) return res.status(404).json({ message: 'Restaurante no encontrado' });

    const limitCheck = await checkReservationLimit(businessId, business);
    if (!limitCheck.allowed) {
      return res.status(403).json({
        message: 'Este restaurante ha alcanzado su limite de reservas este mes. Por favor, contacta directamente con el local.',
        limitReached: true,
      });
    }

    // Dedup: reject if an identical reservation was created in the last 2 minutes
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const duplicate = await Reservation.findOne({
      businessId,
      date,
      time,
      people,
      guestName: { $regex: new RegExp(`^${(guestName || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      createdAt: { $gte: twoMinutesAgo },
    });
    if (duplicate) {
      return res.status(409).json({ message: 'Tu reserva ya fue registrada. Por favor, no envíes el formulario más de una vez.' });
    }

    if (business.maxReservationPeople && Number(people) > business.maxReservationPeople) {
      return res.status(400).json({ message: `No se permiten mas de ${business.maxReservationPeople} personas por reserva` });
    }

    const shiftSlots = await getApplicableShiftSlotsForDate(businessId, date);
    const selectedSlot = shiftSlots.find((s) => s.time === time);
    if (!selectedSlot) {
      return res.status(400).json({ message: 'Ese horario no esta disponible para la fecha seleccionada' });
    }

    const exceptionCheck = await getExceptionBlocksForShift({
      businessId,
      date,
      shiftName: selectedSlot.shiftName,
      roomId: roomId || null,
    });
    if (exceptionCheck.blocked) {
      if (exceptionCheck.type === 'call') {
        return res.status(400).json({
          message: exceptionCheck.message || (business.phone
            ? `Este turno solo admite reservas por telefono (${business.phone})`
            : 'Este turno solo admite reservas por telefono'),
          code: 'EXCEPTION_CALL',
        });
      }
      if (exceptionCheck.type === 'full') {
        return res.status(400).json({
          message: exceptionCheck.message || 'Este turno esta completo',
          code: 'EXCEPTION_FULL',
        });
      }
      if (exceptionCheck.type === 'close_room') {
        return res.status(400).json({
          message: exceptionCheck.message || 'La sala seleccionada esta cerrada para este turno',
          code: 'EXCEPTION_ROOM_CLOSED',
        });
      }
      return res.status(400).json({
        message: exceptionCheck.message || 'El restaurante esta cerrado en este turno',
        code: 'EXCEPTION_CLOSED',
      });
    }

    const decision = await evaluateReservationStatus({ business, businessId, date, time, people });
    if (decision.status === 'rejected_capacity') {
      return res.status(400).json({ message: 'No hay suficiente capacidad en ese horario' });
    }

    let resolvedPromoCode = '';
    let resolvedPromoCodeId = null;
    if (rawPromoCode?.trim()) {
      const PromoCode = require('../models/PromoCode');
      const promo = await PromoCode.findOne({
        businessId,
        code: rawPromoCode.trim().toUpperCase(),
        active: true,
      });
      const now = new Date();
      const expired = promo?.expiresAt && now > new Date(promo.expiresAt);
      const maxed = promo?.maxUses !== null && promo?.usedCount >= promo?.maxUses;
      if (!promo || expired || maxed) {
        return res.status(400).json({ message: 'El codigo promocional no es valido o ha expirado' });
      }
      resolvedPromoCode = promo.code;
      resolvedPromoCodeId = promo._id;
    }

    const customer = await findOrCreateCustomer(businessId, guestName, phone, email);

    // ── Construir objeto de pago ───────────────────────────────────────────
    const rp = business.reservationPayment || {};
    const paymentMode = (business.stripeConnectId && rp.mode && rp.mode !== 'none') ? rp.mode : 'none';
    let paymentData = { mode: 'none', status: 'none' };

    if (paymentMode === 'deposit') {
      if (!paymentIntentId) {
        return res.status(400).json({ message: 'Se requiere pago para completar la reserva' });
      }
      const numPeople = parseInt(people, 10) || 1;
      const amount = rp.depositPerPerson ? rp.depositAmount * numPeople : rp.depositAmount;
      // Verificar con Stripe que el pago fue efectivamente cobrado
      try {
        await stripeService.verifyPaymentIntent({
          stripeConnectId: business.stripeConnectId,
          paymentIntentId,
          expectedAmount:  amount,
        });
      } catch (err) {
        console.error('[createPublicReservation] PaymentIntent inválido:', err.message);
        return res.status(402).json({ message: 'El pago no se ha completado correctamente. Por favor, inténtalo de nuevo.' });
      }
      paymentData = {
        mode:                  'deposit',
        status:                'captured',
        amount,
        currency:              rp.currency ?? 'eur',
        stripePaymentIntentId: paymentIntentId,
        capturedAt:            new Date(),
      };
    } else if (paymentMode === 'card_guarantee') {
      if (!setupIntentId || !paymentMethodId) {
        return res.status(400).json({ message: 'Se requieren datos de tarjeta para completar la reserva' });
      }
      // Verificar con Stripe que el SetupIntent está completado
      try {
        await stripeService.verifySetupIntent({
          stripeConnectId: business.stripeConnectId,
          setupIntentId,
        });
      } catch (err) {
        console.error('[createPublicReservation] SetupIntent inválido:', err.message);
        return res.status(402).json({ message: 'No se ha podido guardar la tarjeta. Por favor, inténtalo de nuevo.' });
      }
      // Crear un customer de Stripe en la cuenta Connect para el huésped y adjuntar el PM
      let stripeGuestCustomerId = null;
      try {
        const guestCustomer = await stripeService.createGuestCustomer({
          stripeConnectId: business.stripeConnectId,
          name:  guestName,
          email: email || undefined,
          metadata: { businessId: businessId.toString() },
        });
        stripeGuestCustomerId = guestCustomer.id;
        await stripeService.attachPaymentMethod({
          stripeConnectId:  business.stripeConnectId,
          paymentMethodId,
          customerId:       stripeGuestCustomerId,
        });
      } catch (err) {
        console.error('[createPublicReservation] error adjuntando PM:', err.message);
        // No bloqueamos la reserva si falla la asociación, pero el PM queda registrado
      }

      paymentData = {
        mode:                  'card_guarantee',
        status:                'pending',
        amount:                rp.noShowFeeAmount ?? 0,
        currency:              rp.currency ?? 'eur',
        stripeSetupIntentId:   setupIntentId,
        stripePaymentMethodId: paymentMethodId,
        stripeCustomerId:      stripeGuestCustomerId,
      };
    }

    const reservation = await Reservation.create({
      businessId,
      customerId: customer?._id || null,
      guestName,
      guestPhone: phone,
      guestEmail: email,
      roomId: roomId || null,
      tableId: tableId || null,
      date,
      time,
      people,
      notes: notes || '',
      consent: consent || false,
      marketingConsent: marketingConsent || false,
      marketingConsentAt: marketingConsent ? new Date() : null,
      marketingConsentText: marketingConsent ? (marketingConsentText || '') : '',
      promoCode: resolvedPromoCode,
      promoCodeId: resolvedPromoCodeId,
      status: decision.status,
      pendingReason: decision.pendingReason,
      payment: paymentData,
    });

    if (resolvedPromoCodeId) {
      const PromoCode = require('../models/PromoCode');
      await PromoCode.updateOne({ _id: resolvedPromoCodeId }, { $inc: { usedCount: 1 } });
    }

    if (marketingConsent && customer?._id) {
      const crypto = require('crypto');
      const update = { marketingSubscribed: true, marketingSubscribedAt: new Date() };
      const existing = await Customer.findById(customer._id).select('unsubscribeToken marketingUnsubscribed');
      if (!existing?.unsubscribeToken) update.unsubscribeToken = crypto.randomBytes(32).toString('hex');
      if (!existing?.marketingUnsubscribed) {
        await Customer.updateOne({ _id: customer._id }, { $set: update });
      }
    }

    const populated = await reservation.populate(POPULATE);
    await updateTableStatusForReservation(populated, businessId);

    if (canUseFeature(business, 'autoEmails') && email) {
      if (populated.status === 'pending') await sendReservationPendingEmail(populated, business);
      else await sendReservationConfirmation(populated, business);
    }
    if (populated.status === 'pending') {
      await notifyStaffPending(businessId, populated);
    } else if (canUseFeature(business, 'staffNotifications')) {
      await notifyStaff(businessId, populated, 'created');
    }

    const payload = populated.toObject ? populated.toObject() : populated;
    if (payload.status === 'pending') {
      payload.statusMessage = 'Tu reserva esta pendiente de aprobacion. Te avisaremos por email cuando el restaurante la revise.';
    }
    res.status(201).json(payload);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.getPublicReservationDetails = async (req, res) => {
  try {
    const { reservationId, email } = req.query;
    if (!reservationId || !email) return res.status(400).json({ message: 'Parametros faltantes' });
    const reservation = await Reservation.findOne({ _id: reservationId, guestEmail: email.toLowerCase() }).populate(POPULATE);
    if (!reservation) return res.status(404).json({ message: 'Reserva no encontrada' });
    res.json(reservation);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.cancelPublicReservation = async (req, res) => {
  try {
    const { reservationId, email } = req.query;
    if (!reservationId || !email) return res.status(400).json({ message: 'Parametros faltantes' });

    const reservation = await Reservation.findOne({ _id: reservationId, guestEmail: email.toLowerCase() });
    if (!reservation) return res.status(404).json({ message: 'Reserva no encontrada' });
    if (reservation.status === 'cancelled') return res.json({ message: 'Esta reserva ya ha sido cancelada anteriormente.' });

    const business = await Business.findById(reservation.businessId)
      .select('name brandColor email phone stripeConnectId reservationPayment plan subscriptionStatus');

    // ── Reembolso automático si el modo es depósito y está dentro de la ventana ──
    const rp = business?.reservationPayment || {};
    const freeCancelHours = rp.freeCancellationHours ?? 24;
    const payment = reservation.payment;

    if (payment?.mode === 'deposit' && payment?.status === 'captured' && payment?.stripePaymentIntentId && business?.stripeConnectId) {
      // Comprobar si la cancelación está dentro de la ventana gratuita
      const reservationDateTime = new Date(`${reservation.date}T${reservation.time}:00`);
      const hoursUntilReservation = (reservationDateTime - new Date()) / (1000 * 60 * 60);

      if (hoursUntilReservation >= freeCancelHours) {
        // Dentro de ventana → reembolso automático
        try {
          await stripeService.refundPaymentIntent({
            stripeConnectId: business.stripeConnectId,
            paymentIntentId: payment.stripePaymentIntentId,
          });
          reservation.payment.status = 'refunded';
          reservation.payment.refundedAt = new Date();
        } catch (err) {
          console.error('[cancelPublicReservation] refund error:', err.message);
          // No bloqueamos la cancelación si el reembolso falla
        }
      }
      // Fuera de ventana → el restaurante se queda el depósito (no reembolsamos)
    }

    reservation.status = 'cancelled';
    await reservation.save();
    await updateTableStatusForReservation(reservation, reservation.businessId);

    if (reservation.customerId) {
      await Customer.findByIdAndUpdate(reservation.customerId, { $inc: { cancellationCount: 1 } });
    }

    if (reservation.guestEmail && business && canUseFeature(business, 'autoEmails')) await sendStatusUpdate(reservation, business, 'cancelled');
    await notifyStaff(reservation.businessId, reservation, 'cancelled');

    const refunded = reservation.payment?.status === 'refunded';
    res.json({
      message: refunded
        ? 'Reserva cancelada correctamente. El depósito será reembolsado en 5-10 días hábiles.'
        : 'Reserva cancelada correctamente.',
      refunded,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.acceptPendingReservation = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select('name brandColor email phone plan subscriptionStatus');
    if (!canUseFeature(business, 'pendingApprovalControl')) {
      return res.status(403).json({ message: 'Esta funcion requiere plan Pro', feature: 'pendingApprovalControl', upgradeRequired: true });
    }

    const reservation = await Reservation.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!reservation) return res.status(404).json({ message: 'Reserva no encontrada' });
    if (reservation.status !== 'pending') return res.status(400).json({ message: 'Solo se pueden aceptar reservas pendientes' });

    reservation.status = 'confirmed';
    reservation.pendingReason = 'none';
    await reservation.save();
    const populated = await reservation.populate(POPULATE);
    await updateTableStatusForReservation(populated, req.businessId);

    if (reservation.guestEmail && business && canUseFeature(business, 'autoEmails')) await sendStatusUpdate(populated, business, 'confirmed');
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.rejectPendingReservation = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select('name brandColor email phone plan subscriptionStatus');
    if (!canUseFeature(business, 'pendingApprovalControl')) {
      return res.status(403).json({ message: 'Esta funcion requiere plan Pro', feature: 'pendingApprovalControl', upgradeRequired: true });
    }

    const reservation = await Reservation.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!reservation) return res.status(404).json({ message: 'Reserva no encontrada' });
    if (reservation.status !== 'pending') return res.status(400).json({ message: 'Solo se pueden rechazar reservas pendientes' });

    reservation.status = 'cancelled';
    reservation.pendingReason = 'none';
    await reservation.save();
    const populated = await reservation.populate(POPULATE);
    await updateTableStatusForReservation(populated, req.businessId);

    if (reservation.guestEmail && business && canUseFeature(business, 'autoEmails')) await sendStatusUpdate(populated, business, 'cancelled');
    await notifyStaff(req.businessId, populated, 'cancelled');
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.proposeAlternativeTime = async (req, res) => {
  try {
    const { date, time, message = '' } = req.body || {};
    const reservation = await Reservation.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!reservation) return res.status(404).json({ message: 'Reserva no encontrada' });
    if (reservation.status !== 'pending') return res.status(400).json({ message: 'Solo se puede proponer alternativa a reservas pendientes' });

    const business = await Business.findById(req.businessId).select(
      'name brandColor email phone maxPeoplePerSlot reservationDuration requireApprovalAbove plan subscriptionStatus'
    );
    if (!canUseFeature(business, 'pendingApprovalControl')) {
      return res.status(403).json({ message: 'Esta funcion requiere plan Pro', feature: 'pendingApprovalControl', upgradeRequired: true });
    }

    let alternative = null;
    if (date && time) alternative = { date, time };
    if (!alternative) {
      alternative = await suggestAlternativeSlot({ business, reservation });
      if (!alternative) {
        return res.status(400).json({ message: 'No se encontro una alternativa disponible automaticamente' });
      }
    }

    reservation.proposedAlternative = {
      date: alternative.date,
      time: alternative.time,
      message: String(message || '').trim(),
      proposedAt: new Date(),
    };
    await reservation.save();
    const populated = await reservation.populate(POPULATE);

    if (reservation.guestEmail) await sendAlternativeProposalEmail(populated, business);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.markNoShow = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select('plan subscriptionStatus');
    if (!canUseFeature(business, 'noShowTracking')) {
      return res.status(403).json({ message: 'Esta funcion requiere plan Pro', feature: 'noShowTracking', upgradeRequired: true });
    }

    const reservation = await Reservation.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!reservation) return res.status(404).json({ message: 'Reserva no encontrada' });
    if (!['confirmed', 'seated'].includes(reservation.status)) {
      return res.status(400).json({ message: 'Solo reservas confirmadas o sentadas pueden marcarse como no-show' });
    }

    reservation.status = 'no_show';
    await reservation.save();
    await updateTableStatusForReservation(reservation, req.businessId);

    if (reservation.customerId) {
      await Customer.findByIdAndUpdate(reservation.customerId, { $inc: { noShowCount: 1 } });
    }

    res.json(await reservation.populate(POPULATE));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateReservation = async (req, res) => {
  try {
    const old = await Reservation.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!old) return res.status(404).json({ message: 'Reservation not found' });

    if (req.body?.status === 'no_show') {
      const business = await Business.findById(req.businessId).select('plan subscriptionStatus');
      if (!canUseFeature(business, 'noShowTracking')) {
        return res.status(403).json({ message: 'Esta funcion requiere plan Pro', feature: 'noShowTracking', upgradeRequired: true });
      }
    }

    // If tableIds is provided, sync tableId to the first element
    const body = { ...req.body };
    if (Array.isArray(body.tableIds)) {
      body.tableId = body.tableIds[0] || null;
    }

    const reservation = await Reservation.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      body,
      { new: true, runValidators: true }
    ).populate(POPULATE);

    // Collect old and new table IDs to free tables that were removed
    const oldIds = new Set([
      ...(old.tableIds?.map(id => id.toString()) || []),
      ...(old.tableId ? [old.tableId.toString()] : []),
    ]);
    const newIds = new Set([
      ...(reservation.tableIds?.map(t => (t?._id || t).toString()) || []),
      ...(reservation.tableId ? [(reservation.tableId?._id || reservation.tableId).toString()] : []),
    ]);
    const removedIds = [...oldIds].filter(id => !newIds.has(id));
    if (removedIds.length > 0) {
      await Table.updateMany({ _id: { $in: removedIds }, businessId: req.businessId }, { status: 'free' });
    }
    await updateTableStatusForReservation(reservation, req.businessId);

    if (reservation.status === 'seated' && old.status !== 'seated' && reservation.customerId) {
      await Customer.findByIdAndUpdate(reservation.customerId._id, { $inc: { visits: 1 } });
    }
    if (reservation.status === 'cancelled' && old.status !== 'cancelled' && reservation.customerId) {
      await Customer.findByIdAndUpdate(reservation.customerId._id, { $inc: { cancellationCount: 1 } });
    }
    if (reservation.status === 'no_show' && old.status !== 'no_show' && reservation.customerId) {
      await Customer.findByIdAndUpdate(reservation.customerId._id, { $inc: { noShowCount: 1 } });
    }

    const statusChanged = reservation.status !== old.status;
    if (statusChanged && reservation.guestEmail && ['confirmed', 'cancelled'].includes(reservation.status)) {
      const business = await Business.findById(req.businessId).select('name brandColor email phone plan subscriptionStatus');
      if (canUseFeature(business, 'autoEmails')) {
        await sendStatusUpdate(reservation, business, reservation.status);
      }
    }
    if (statusChanged && reservation.status === 'cancelled') {
      await notifyStaff(req.businessId, reservation, 'cancelled');
    }

    res.json(reservation);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteReservation = async (req, res) => {
  try {
    const reservation = await Reservation.findOneAndDelete({ _id: req.params.id, businessId: req.businessId });
    if (!reservation) return res.status(404).json({ message: 'Reservation not found' });
    const idsToFree = new Set([
      ...(reservation.tableIds?.map(id => id.toString()) || []),
      ...(reservation.tableId ? [reservation.tableId.toString()] : []),
    ]);
    if (idsToFree.size > 0) {
      await Table.updateMany({ _id: { $in: [...idsToFree] }, businessId: req.businessId }, { status: 'free' });
    }
    res.json({ message: 'Reservation deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
