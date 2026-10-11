/**
 * Packs ("bonos") in the database: the catalogue, selling one to a customer
 * and spending/returning its sessions when an appointment is charged or the
 * charge is undone.
 */
const Customer = require('../../../core/models/Customer');
const Pack = require('../models/Pack');
const CustomerPack = require('../models/CustomerPack');
const { BookingError } = require('../lib/errors');
const { buildSale, packStatus, coversBooking } = require('../lib/packs');

async function listCatalog(businessId, { includeInactive = false } = {}) {
  return Pack.find({ businessId, ...(includeInactive ? {} : { active: true }) }).sort({ sortOrder: 1, name: 1 }).lean();
}

async function listForCustomer(businessId, customerId, now = new Date()) {
  const rows = await CustomerPack.find({ businessId, customerId }).sort({ soldAt: -1 }).lean();
  return rows.map((p) => ({ ...p, status: packStatus(p, now) }));
}

async function sell(businessId, customerId, packId, body, ctx) {
  const [customer, pack] = await Promise.all([
    Customer.exists({ _id: customerId, businessId }),
    Pack.findOne({ _id: packId, businessId }).lean(),
  ]);
  if (!customer) throw new BookingError(404, 'Cliente no encontrado', 'NOT_FOUND');
  if (!pack) throw new BookingError(404, 'Bono no encontrado', 'NOT_FOUND');
  const sale = buildSale(pack, body, ctx);
  return (await CustomerPack.create({ businessId, customerId, ...sale })).toObject();
}

/**
 * Spends one session of a customer's pack on `booking`. Atomic: two people
 * charging at once cannot both take the last session.
 */
async function consume(businessId, customerPackId, booking, now = new Date()) {
  if (!booking.customerId) throw new BookingError(400, 'Esta cita no está asociada a un cliente con bono', 'BAD_REQUEST');
  const sold = await CustomerPack.findOne({ _id: customerPackId, businessId, customerId: booking.customerId }).lean();
  if (!sold) throw new BookingError(404, 'Bono no encontrado', 'NOT_FOUND');
  const status = packStatus(sold, now);
  if (status === 'expired') throw new BookingError(409, 'Este bono ha caducado', 'PACK_EXPIRED');
  if (status === 'used_up') throw new BookingError(409, 'Este bono ya no tiene sesiones', 'PACK_USED_UP');
  if (!coversBooking(sold, booking)) throw new BookingError(409, 'Este bono no cubre todos los servicios de la cita', 'PACK_NOT_VALID');
  const updated = await CustomerPack.findOneAndUpdate(
    { _id: sold._id, remaining: { $gt: 0 } },
    { $inc: { remaining: -1 }, $push: { uses: { bookingId: booking._id, usedAt: now } } },
    { new: true },
  ).lean();
  if (!updated) throw new BookingError(409, 'Este bono ya no tiene sesiones', 'PACK_USED_UP');
  return updated;
}

/** Gives the session back (the charge was undone or failed). */
async function restore(businessId, customerPackId, bookingId) {
  await CustomerPack.updateOne(
    { _id: customerPackId, businessId, 'uses.bookingId': bookingId },
    { $inc: { remaining: 1 }, $pull: { uses: { bookingId } } },
  );
}

module.exports = { listCatalog, listForCustomer, sell, consume, restore };
