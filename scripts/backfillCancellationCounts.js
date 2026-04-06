/**
 * backfillCancellationCounts.js
 *
 * Migración one-time:
 * - Cuenta reservas canceladas por customerId y actualiza cancellationCount
 * - Rellena normalizedPhone en clientes que no lo tienen
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

  const db = mongoose.connection.db;
  const reservations = db.collection('reservations');
  const customers    = db.collection('customers');

  // ── 1. Backfill cancellationCount ──────────────────────────────────────────
  const { ObjectId } = require('mongodb');

  const agg = await reservations.aggregate([
    { $match: { status: 'cancelled', customerId: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: { $toString: '$customerId' },  // normalizar a string para agrupar independientemente del tipo
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  console.log(`Clientes con reservas canceladas encontrados: ${agg.length}`);

  let updatedCount = 0;
  for (const { _id: idStr, count } of agg) {
    // Intentar como ObjectId primero, fallback a string
    let objectId;
    try { objectId = new ObjectId(idStr); } catch { objectId = null; }

    const query = objectId ? { $or: [{ _id: objectId }, { _id: idStr }] } : { _id: idStr };
    const result = await customers.updateOne(query, { $set: { cancellationCount: count } });

    if (result.matchedCount > 0) {
      console.log(`  ✓ customerId ${idStr} → cancellationCount: ${count}`);
      updatedCount++;
    } else {
      console.warn(`  ✗ No se encontró customer con _id: ${idStr}`);
    }
  }

  // ── 2. Backfill normalizedPhone ────────────────────────────────────────────
  const withoutPhone = await customers.find({
    $or: [
      { normalizedPhone: { $exists: false } },
      { normalizedPhone: '' },
      { normalizedPhone: null },
    ],
    phone: { $exists: true, $nin: ['', null] },
  }).toArray();

  console.log(`\nClientes sin normalizedPhone: ${withoutPhone.length}`);

  let phonesUpdated = 0;
  for (const c of withoutPhone) {
    const normalized = String(c.phone).replace(/\D/g, '');
    if (normalized) {
      await customers.updateOne({ _id: c._id }, { $set: { normalizedPhone: normalized } });
      phonesUpdated++;
    }
  }

  console.log(`\nResumen:`);
  console.log(`  cancellationCount actualizado: ${updatedCount} clientes`);
  console.log(`  normalizedPhone rellenado:     ${phonesUpdated} clientes`);
  console.log('\nHecho.');
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
