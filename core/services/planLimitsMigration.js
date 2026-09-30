/**
 * One-time step when the appointment plan limits arrive: every business that
 * already exists keeps its team, reminders and follow-ups (legacyAccess), so
 * nobody loses what they use today. Runs at startup, only once per database
 * (recorded in the appmigrations collection).
 */
const mongoose = require('mongoose');
const Business = require('../models/Business');

const MIGRATION_ID = 'plan-limits-legacy-access-v1';

async function ensurePlanLimitsMigration({ log = console } = {}) {
  const col = mongoose.connection.collection('appmigrations');
  if (await col.findOne({ _id: MIGRATION_ID, finishedAt: { $ne: null } })) return 0;
  // Idempotent: two instances running it at once set the same flag.
  const r = await Business.updateMany({ legacyAccess: { $ne: true } }, { $set: { legacyAccess: true } });
  const n = r.modifiedCount ?? r.nModified ?? 0;
  await col.updateOne({ _id: MIGRATION_ID }, { $set: { finishedAt: new Date(), businesses: n } }, { upsert: true });
  log.info?.(`[plans] legacy access kept for ${n} existing business(es)`);
  return n;
}

module.exports = { ensurePlanLimitsMigration, MIGRATION_ID };
