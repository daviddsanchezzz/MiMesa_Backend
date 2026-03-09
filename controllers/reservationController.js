const Reservation = require('../models/Reservation');
const Customer    = require('../models/Customer');
const Table       = require('../models/Table');
const Business    = require('../models/Business');
const { sendReservationConfirmation, sendStatusUpdate } = require('../services/email');

const POPULATE = [
  { path: 'customerId', select: 'name phone email visits' },
  { path: 'tableId', select: 'name capacity roomId', populate: { path: 'roomId', select: 'name' } },
  { path: 'roomId', select: 'name' },
];

/** Find existing customer by phone or email, or create a new one. */
async function findOrCreateCustomer(businessId, guestName, guestPhone, guestEmail) {
  if (!guestPhone && !guestEmail) return null;
  const orClauses = [];
  if (guestPhone) orClauses.push({ phone: guestPhone });
  if (guestEmail) orClauses.push({ email: guestEmail.toLowerCase() });
  let customer = await Customer.findOne({ businessId, $or: orClauses });
  if (!customer) {
    customer = await Customer.create({
      businessId, name: guestName,
      phone: guestPhone || '', email: guestEmail || '',
    });
  }
  return customer;
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

    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.createPublicReservation = async (req, res) => {
  try {
    const { businessId, guestName, guestPhone, guestEmail, roomId, tableId, date, time, people, notes, consent } = req.body;

    const business = await Business.findById(businessId).select('name brandColor maxReservationPeople email phone');
    if (business?.maxReservationPeople && people > business.maxReservationPeople) {
      return res.status(400).json({ message: `No se permiten más de ${business.maxReservationPeople} personas por reserva` });
    }

    const customer = await findOrCreateCustomer(businessId, guestName, guestPhone, guestEmail);
    const reservation = await Reservation.create({
      businessId,
      customerId: customer?._id || null,
      guestName, guestPhone: guestPhone || '', guestEmail: guestEmail || '',
      roomId:  roomId  || null,
      tableId: tableId || null,
      date, time, people, notes: notes || '', consent: consent || false,
    });
    if (tableId) {
      await Table.findOneAndUpdate({ _id: tableId, businessId }, { status: 'reserved' });
    }
    const populated = await reservation.populate(POPULATE);

    // Send confirmation email
    if (guestEmail && business) {
      sendReservationConfirmation(populated, business);
    }

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
