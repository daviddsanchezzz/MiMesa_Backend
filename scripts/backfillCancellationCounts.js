/**
 * backfillCancellationCounts.js
 *
 * Script de migración one-time:
 * - Recorre todas las reservas canceladas con customerId
 * - Cuenta cuántas tiene cada cliente
 * - Actualiza cancellationCount en Customer
 *
 * Uso:
 *   cd backend
 *   node scripts/backfillCancellationCounts.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Conectado a MongoDB');

  const Reservation = require('../models/Reservation');
  const Customer    = require('../models/Customer');

  // Agrupar reservas canceladas por customerId
  const agg = await Reservation.aggregate([
    { $match: { status: 'cancelled', customerId: { $exists: true, $ne: null } } },
    { $group: { _id: '$customerId', count: { $sum: 1 } } },
  ]);

  console.log(`Clientes con cancelaciones: ${agg.length}`);

  let updated = 0;
  for (const { _id, count } of agg) {
    await Customer.updateOne({ _id }, { $set: { cancellationCount: count } });
    updated++;
  }

  // También rellenar normalizedPhone en clientes que no lo tienen
  const withoutNormPhone = await Customer.find({
    $or: [
      { normalizedPhone: { $exists: false } },
      { normalizedPhone: '' },
      { normalizedPhone: null },
    ],
    phone: { $nin: ['', null] },
  });
  console.log(`Clientes sin normalizedPhone: ${withoutNormPhone.length}`);

  for (const c of withoutNormPhone) {
    const normalized = String(c.phone).replace(/\D/g, '');
    if (normalized) {
      await Customer.updateOne({ _id: c._id }, { $set: { normalizedPhone: normalized } });
    }
  }

  console.log(`cancellationCount actualizado en ${updated} clientes`);
  console.log(`normalizedPhone rellenado en ${withoutNormPhone.length} clientes`);
  console.log('Hecho.');
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
