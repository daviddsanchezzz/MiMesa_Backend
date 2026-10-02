/**
 * Restaurant reservations of a customer for data requests (RGPD): export and
 * erase. Erasing keeps the reservation (date, people, payment records) but
 * removes who it was.
 */
const crypto = require('crypto');
const { registerCustomerData } = require('../../core/lib/customerData');
const Reservation = require('./models/Reservation');

const ERASED_NAME = 'Cliente eliminado';

function ownQuery(businessId, customer) {
  const or = [{ customerId: customer._id }];
  if (customer.email) or.push({ guestEmail: String(customer.email).toLowerCase() });
  return { businessId, $or: or };
}

const today = () => new Date().toISOString().slice(0, 10);

registerCustomerData({
  key: 'reservations',
  label: 'reservas',
  upcoming: ({ businessId, customer }) => Reservation.countDocuments({
    ...ownQuery(businessId, customer), status: { $in: ['pending', 'confirmed'] }, date: { $gte: today() },
  }),
  exportRows: async ({ businessId, customer }) => {
    const rows = await Reservation.find(ownQuery(businessId, customer)).sort({ date: 1, time: 1 }).lean();
    return rows.map((r) => ({
      fecha: r.date,
      hora: r.time,
      personas: r.people,
      estado: r.status,
      nombre: r.guestName,
      telefono: r.guestPhone,
      email: r.guestEmail,
      notas: r.notes || '',
      consentimiento_marketing: !!r.marketingConsent,
      pago: r.payment?.amount ? { importe: r.payment.amount / 100, estado: r.payment.paymentStatus } : null,
      creada: r.createdAt,
    }));
  },
  erase: async ({ businessId, customer }) => {
    const rows = await Reservation.find(ownQuery(businessId, customer)).select('_id').lean();
    for (const r of rows) {
      await Reservation.updateOne({ _id: r._id }, {
        $set: {
          customerId: null, guestName: ERASED_NAME, guestPhone: '', guestEmail: '', notes: '',
          marketingConsent: false, marketingConsentText: '',
          publicToken: crypto.randomBytes(24).toString('hex'),
        },
      });
    }
    return rows.length;
  },
});

// Deleting the business deletes the whole restaurant setup and its reservations.
const { registerBusinessData, deleteAllFor } = require('../../core/lib/businessData');

registerBusinessData({
  key: 'restaurant',
  erase: (businessId) => deleteAllFor(businessId, {
    Reservation,
    Room: require('./models/Room'),
    Table: require('./models/Table'),
    Shift: require('./models/Shift'),
    Vacation: require('./models/Vacation'),
    Exception: require('./models/Exception'),
    PromoCode: require('./models/PromoCode'),
    ReminderLog: require('./models/ReminderLog'),
  }),
});
