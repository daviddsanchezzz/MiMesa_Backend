/**
 * mergeDuplicateCustomers.js
 *
 * One-time maintenance script:
 * - Detects customer duplicates per business by phone variants (Spain +34/0034/local)
 * - Keeps the oldest customer as canonical
 * - Reassigns reservations.customerId from duplicates to canonical
 * - Aggregates counters and metadata (visits/noShow/cancellation, vip, notes)
 * - Deletes duplicate customer rows
 *
 * Usage:
 *   cd backend
 *   node scripts/mergeDuplicateCustomers.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { toStoredNormalizedPhone } = require('../lib/phoneMatching');

function uniqueNotes(values) {
  const items = values
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return [...new Set(items)].join('\n');
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const customers = db.collection('customers');
  const reservations = db.collection('reservations');

  const all = await customers.find({}).sort({ createdAt: 1 }).toArray();

  const groups = new Map();
  for (const c of all) {
    const canonicalPhone = toStoredNormalizedPhone(c.phone || c.normalizedPhone || '');
    if (!canonicalPhone) continue;
    const key = `${String(c.businessId)}::${canonicalPhone}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const duplicateGroups = [...groups.values()].filter((arr) => arr.length > 1);
  console.log(`Duplicate groups found: ${duplicateGroups.length}`);

  let mergedGroups = 0;
  let deletedCustomers = 0;
  let reservationsReassigned = 0;

  for (const group of duplicateGroups) {
    const sorted = [...group].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const keeper = sorted[0];
    const duplicates = sorted.slice(1);
    const duplicateIds = duplicates.map((d) => d._id);

    const aggregate = sorted.reduce((acc, c) => {
      acc.visits += Number(c.visits || 0);
      acc.noShowCount += Number(c.noShowCount || 0);
      acc.cancellationCount += Number(c.cancellationCount || 0);
      acc.vip = acc.vip || Boolean(c.vip);
      if (!acc.email && c.email) acc.email = c.email;
      if (!acc.phone && c.phone) acc.phone = c.phone;
      acc.notes.push(c.notes || '');
      return acc;
    }, {
      visits: 0,
      noShowCount: 0,
      cancellationCount: 0,
      vip: false,
      email: keeper.email || '',
      phone: keeper.phone || '',
      notes: [],
    });

    const notes = uniqueNotes(aggregate.notes);
    const normalizedPhone = toStoredNormalizedPhone(aggregate.phone || keeper.phone || keeper.normalizedPhone || '');

    const update = {
      visits: aggregate.visits,
      noShowCount: aggregate.noShowCount,
      cancellationCount: aggregate.cancellationCount,
      vip: aggregate.vip,
      email: aggregate.email || '',
      phone: aggregate.phone || keeper.phone || '',
      notes,
      normalizedPhone,
    };

    await customers.updateOne({ _id: keeper._id }, { $set: update });

    const reassigned = await reservations.updateMany(
      { customerId: { $in: duplicateIds } },
      { $set: { customerId: keeper._id } }
    );
    reservationsReassigned += Number(reassigned.modifiedCount || 0);

    const removed = await customers.deleteMany({ _id: { $in: duplicateIds } });
    deletedCustomers += Number(removed.deletedCount || 0);
    mergedGroups += 1;

    console.log(`Merged group -> keeper ${keeper._id} | removed ${duplicateIds.length}`);
  }

  console.log('\nSummary:');
  console.log(`  Groups merged:           ${mergedGroups}`);
  console.log(`  Customers deleted:       ${deletedCustomers}`);
  console.log(`  Reservations reassigned: ${reservationsReassigned}`);
  console.log('\nDone.');

  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

