/** Loyalty in the database: the rule of the business and where a customer stands. */
const LoyaltySettings = require('../models/LoyaltySettings');
const Booking = require('../models/Booking');
const { shape, settingsInput, progress } = require('../lib/loyalty');

async function getSettings(businessId) {
  return shape(await LoyaltySettings.findOne({ businessId }).lean());
}

async function saveSettings(businessId, body) {
  const input = settingsInput(body);
  await LoyaltySettings.updateOne({ businessId }, { $set: input, $setOnInsert: { businessId } }, { upsert: true });
  return getSettings(businessId);
}

/** Visits that were paid at the till (pack sessions included). */
async function progressFor(businessId, customerId) {
  const [doc, paidVisits] = await Promise.all([
    LoyaltySettings.findOne({ businessId }).lean(),
    Booking.countDocuments({ businessId, customerId, payment: { $ne: null } }),
  ]);
  return progress(doc, paidVisits);
}

module.exports = { getSettings, saveSettings, progressFor };
