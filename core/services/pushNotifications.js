const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

let vapidInitialized = false;

function ensureVapid() {
  if (vapidInitialized) return true;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@vetrareserve.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  vapidInitialized = true;
  return true;
}

async function sendPushToBusinessStaff(businessId, payload) {
  if (!ensureVapid()) return;

  try {
    const subs = await PushSubscription.find({ businessId }).lean();
    if (subs.length === 0) return;

    await Promise.allSettled(
      subs.map(async (doc) => {
        try {
          await webpush.sendNotification(doc.subscription, JSON.stringify(payload));
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await PushSubscription.deleteOne({ _id: doc._id });
          }
        }
      })
    );
  } catch (err) {
    console.error('[push] sendPushToBusinessStaff failed:', err.message);
  }
}

/** Push to specific people of a business (an employee, the managers…). */
async function sendPushToUsers(businessId, userIds, payload) {
  if (!ensureVapid() || !Array.isArray(userIds) || userIds.length === 0) return;
  try {
    const subs = await PushSubscription.find({ businessId, userId: { $in: userIds.map(String) } }).lean();
    await Promise.allSettled(subs.map(async (doc) => {
      try {
        await webpush.sendNotification(doc.subscription, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) await PushSubscription.deleteOne({ _id: doc._id });
      }
    }));
  } catch (err) {
    console.error('[push] sendPushToUsers failed:', err.message);
  }
}

module.exports = { sendPushToBusinessStaff, sendPushToUsers };
