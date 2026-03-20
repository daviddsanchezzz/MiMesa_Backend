const Reservation = require('../models/Reservation');
const Customer    = require('../models/Customer');
const Table       = require('../models/Table');
const Business    = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');
const {
  sendReservationConfirmation,
  sendStatusUpdate,
  sendStaffReservationNotification,
} = require('../services/email');

const POPULATE = [
  { path: 'customerId', select: 'name phone email visits' },
  { path: 'tableId', select: 'name capacity roomId', populate: { path: 'roomId', select: 'name' } },
  { path: 'roomId', select: 'name' },
];

/** Find existing customer by phone or email, or create a new one. */
async function findOrCreateCustomer(businessId, guestName, guestPhone, guestEmail) {
  const phone = (guestPhone || '').trim();
  const email = (guestEmail || '').trim().toLowerCase();
  const name = (guestName || '').trim();

  if (!phone && !email) return null;

  // Email has priority as unique identity for customers.
  let customer = null;
  if (email) {
    customer = await Customer.findOne({ businessId, email });
  }

  if (!customer && phone) {
    customer = await Customer.findOne({ businessId, phone });
  }

  if (!customer) {
    return Customer.create({
      businessId,
      name,
      phone,
      email,
    });
  }

  // Keep customer data fresh without overriding with empty values.
  const update = {};
  if (name && customer.name !== name) update.name = name;
  if (phone && customer.phone !== phone) update.phone = phone;
  if (email && customer.email !== email) update.email = email;
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
    await sendStaffReservationNotification(recipients, reservation, business, eventType);
  } catch (err) {
    console.error('[reservations] notifyStaff failed:', err.message);
  }
}

exports.getReservations = async (req, res) => {
  try {
    const filter = { businessId: req.businessId };
    if (req.query.date) filter.date = req.query.date;
    const reservations = await Reservation.find(filter).populate(POPULATE).sort('time');
    res.json(reservations);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createReservation = async (req, res) => {
  try {
    const { guestName, guestPhone, guestEmail, roomId, tableId, date, time, people, notes, consent } = req.body;
    const customer = await findOrCreateCustomer(req.businessId, guestName, guestPhone, guestEmail);
    const reservation = await Reservation.create({
      businessId: req.businessId,
      customerId: customer?._id || null,
      guestName, guestPhone: guestPhone || '', guestEmail: guestEmail || '',
      roomId:  roomId  || null,
      tableId: tableId || null,
      date, time, people, notes: notes || '', consent: consent || false,
    });
    if (tableId) {
      await Table.findOneAndUpdate({ _id: tableId, businessId: req.businessId }, { status: 'reserved' });
    }
    const populated = await reservation.populate(POPULATE);

    // Send confirmation email (fire-and-forget, non-blocking)
    if (guestEmail) {
      const business = await Business.findById(req.businessId).select('name brandColor email phone');
      sendReservationConfirmation(populated, business);
    }
    notifyStaff(req.businessId, populated, 'created');

    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.createPublicReservation = async (req, res) => {
  try {
    const { businessId, guestName, guestPhone, guestEmail, roomId, tableId, date, time, people, notes, consent } = req.body;
    const phone = (guestPhone || '').trim();
    const email = (guestEmail || '').trim().toLowerCase();

    if (!phone) {
      return res.status(400).json({ message: 'El teléfono es obligatorio' });
    }
    if (!email) {
      return res.status(400).json({ message: 'El email es obligatorio' });
    }

    const business = await Business.findById(businessId).select('name brandColor maxReservationPeople maxPeoplePerSlot reservationDuration email phone');
    if (business?.maxReservationPeople && people > business.maxReservationPeople) {
      return res.status(400).json({ message: `No se permiten más de ${business.maxReservationPeople} personas por reserva` });
    }

    if (business?.maxPeoplePerSlot) {
      const duration = business.reservationDuration || 0;
      const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      const slotMin = toMinutes(time);

      const existing = await Reservation.find({
        businessId, date, status: { $nin: ['cancelled'] },
      }).select('time people');

      const used = existing.reduce((sum, r) => {
        const rMin = toMinutes(r.time);
        if (rMin <= slotMin && (duration === 0 ? rMin === slotMin : rMin + duration > slotMin)) {
          return sum + r.people;
        }
        return sum;
      }, 0);

      if (used + people > business.maxPeoplePerSlot) {
        return res.status(400).json({ message: `No hay suficiente capacidad en ese horario` });
      }
    }

    const customer = await findOrCreateCustomer(businessId, guestName, phone, email);
    const reservation = await Reservation.create({
      businessId,
      customerId: customer?._id || null,
      guestName, guestPhone: phone, guestEmail: email,
      roomId:  roomId  || null,
      tableId: tableId || null,
      date, time, people, notes: notes || '', consent: consent || false,
    });
    if (tableId) {
      await Table.findOneAndUpdate({ _id: tableId, businessId }, { status: 'reserved' });
    }
    const populated = await reservation.populate(POPULATE);

    // Send confirmation email
    if (email && business) {
      sendReservationConfirmation(populated, business);
    }
    notifyStaff(businessId, populated, 'created');

    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

/**
 * Public reservation details endpoint for cancel page.
 * Returns reservation details without modifying it.
 */
exports.getPublicReservationDetails = async (req, res) => {
  try {
    const { reservationId, email } = req.query;
    if (!reservationId || !email) {
      return res.status(400).json({ message: 'Parámetros faltantes' });
    }

    const reservation = await Reservation.findOne({ _id: reservationId, guestEmail: email.toLowerCase() })
      .populate(POPULATE);
    if (!reservation) {
      return res.status(404).json({ message: 'Reserva no encontrada' });
    }

    res.json(reservation);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Public cancellation endpoint invoked via email link.  
 * Expects reservationId and guest email (for simple verification).
 * If found and not already cancelled, updates status and frees table.
 */
exports.cancelPublicReservation = async (req, res) => {
  try {
    const { reservationId, email } = req.query;
    if (!reservationId || !email) {
      return res.status(400).json({ message: 'Parámetros faltantes' });
    }

    const reservation = await Reservation.findOne({ _id: reservationId, guestEmail: email.toLowerCase() });
    if (!reservation) {
      return res.status(404).json({ message: 'Reserva no encontrada' });
    }
    if (reservation.status === 'cancelled') {
      return res.json({ message: 'Esta reserva ya ha sido cancelada anteriormente.' });
    }

    reservation.status = 'cancelled';
    await reservation.save();

    if (reservation.tableId) {
      await Table.findOneAndUpdate({ _id: reservation.tableId }, { status: 'free' });
    }

    // notify guest / business about cancellation via email
    const business = await Business.findById(reservation.businessId).select('name brandColor email phone');
    if (reservation.guestEmail && business) {
      sendStatusUpdate(reservation, business, 'cancelled');
    }
    notifyStaff(reservation.businessId, reservation, 'cancelled');

    res.json({ message: 'Reserva cancelada correctamente' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateReservation = async (req, res) => {
  try {
    const old = await Reservation.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!old) return res.status(404).json({ message: 'Reservation not found' });

    const reservation = await Reservation.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      req.body, { new: true }
    ).populate(POPULATE);

    const oldTableId = old.tableId?.toString();
    const newTableId = reservation.tableId?._id?.toString();

    // Free old table if it changed
    if (oldTableId && oldTableId !== newTableId) {
      await Table.findOneAndUpdate({ _id: oldTableId, businessId: req.businessId }, { status: 'free' });
    }

    // Set new table status
    if (newTableId) {
      let tableStatus = 'reserved';
      if (reservation.status === 'seated')    tableStatus = 'occupied';
      if (reservation.status === 'cancelled') tableStatus = 'free';
      await Table.findOneAndUpdate({ _id: newTableId, businessId: req.businessId }, { status: tableStatus });
    }

    // Increment visits when first seated
    if (reservation.status === 'seated' && old.status !== 'seated' && reservation.customerId) {
      await Customer.findByIdAndUpdate(reservation.customerId._id, { $inc: { visits: 1 } });
    }

    // Send status-change email (confirmed or cancelled)
    const statusChanged = reservation.status !== old.status;
    if (statusChanged && reservation.guestEmail && ['confirmed', 'cancelled'].includes(reservation.status)) {
      const business = await Business.findById(req.businessId).select('name brandColor email phone');
      sendStatusUpdate(reservation, business, reservation.status);
    }
    if (statusChanged && reservation.status === 'cancelled') {
      notifyStaff(req.businessId, reservation, 'cancelled');
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
    if (reservation.tableId) {
      await Table.findOneAndUpdate({ _id: reservation.tableId, businessId: req.businessId }, { status: 'free' });
    }
    res.json({ message: 'Reservation deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
