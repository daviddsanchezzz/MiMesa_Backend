const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL || 'admin@tableo.app'}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

async function sendPushToBusinessStaff(businessId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

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

module.exports = { sendPushToBusinessStaff };
