/**
 * Appointments of a customer for data requests (RGPD): export and erase.
 * Erasing keeps the appointment (dates, services, money: the business's own
 * records) but removes who it was.
 */
const crypto = require('crypto');
const { registerCustomerData } = require('../../core/lib/customerData');
const Booking = require('./models/Booking');
const Resource = require('./models/Resource');

const ERASED_NAME = 'Cliente eliminado';

function ownQuery(businessId, customer) {
  const or = [{ customerId: customer._id }];
  if (customer.email) or.push({ guestEmail: String(customer.email).toLowerCase() });
  return { businessId, $or: or };
}

registerCustomerData({
  key: 'bookings',
  label: 'citas',
  upcoming: ({ businessId, customer }) => Booking.countDocuments({
    ...ownQuery(businessId, customer), status: { $in: ['pending', 'confirmed', 'checked_in'] }, start: { $gt: new Date() },
  }),
  exportRows: async ({ businessId, customer }) => {
    const rows = await Booking.find(ownQuery(businessId, customer)).sort({ start: 1 }).lean();
    const ids = [...new Set(rows.flatMap((b) => b.segments.flatMap((s) => (s.resourceIds || []).map(String))))];
    const names = new Map((await Resource.find({ _id: { $in: ids } }).select('name').lean()).map((r) => [String(r._id), r.name]));
    return rows.map((b) => ({
      inicio: b.start,
      fin: b.end,
      estado: b.status,
      servicios: b.segments.map((s) => ({ servicio: s.serviceName, con: (s.resourceIds || []).map((id) => names.get(String(id))).filter(Boolean) })),
      precio: (b.totalPrice || 0) / 100,
      cobro: b.payment ? { total: (b.payment.total || 0) / 100, metodo: b.payment.method, fecha: b.payment.paidAt } : null,
      origen: b.source,
      nombre: b.guestName,
      telefono: b.guestPhone,
      email: b.guestEmail,
      nota_del_cliente: b.notes || '',
      nota_interna: b.internalNotes || '',
      creada: b.createdAt,
    }));
  },
  erase: async ({ businessId, customer }) => {
    const rows = await Booking.find(ownQuery(businessId, customer)).select('_id').lean();
    for (const b of rows) {
      await Booking.updateOne({ _id: b._id }, {
        $set: {
          customerId: null, guestName: ERASED_NAME, guestPhone: '', guestEmail: '', notes: '', internalNotes: '',
          publicToken: crypto.randomBytes(24).toString('hex'), // old email links stop working
        },
      });
    }
    return rows.length;
  },
});

// Deleting the business deletes the whole agenda.
const { registerBusinessData, deleteAllFor } = require('../../core/lib/businessData');

registerBusinessData({
  key: 'bookings',
  erase: (businessId) => deleteAllFor(businessId, {
    Booking,
    Occupancy: require('./models/Occupancy'),
    Absence: require('./models/Absence'),
    CashClose: require('./models/CashClose'),
    Schedule: require('./models/Schedule'),
    Service: require('./models/Service'),
    Resource,
    FollowUpSettings: require('./models/FollowUpSettings'),
    BookingPolicy: require('./models/BookingPolicy'),
  }),
});

// Pro is billed per professional (core/services/billingSeats)
require('../../core/services/billingSeats').registerSeatCounter(
  (businessId) => Resource.countDocuments({ businessId, kind: 'staff', active: true }),
);
