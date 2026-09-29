const mongoose = require('mongoose');

const pushSubscriptionSchema = new mongoose.Schema({
  userId:     { type: String, required: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  subscription: {
    endpoint: { type: String, required: true },
    expirationTime: { type: Number, default: null },
    keys: {
      p256dh: { type: String, required: true },
      auth:   { type: String, required: true },
    },
  },
}, { timestamps: true });

pushSubscriptionSchema.index(
  { userId: 1, businessId: 1, 'subscription.endpoint': 1 },
  { unique: true }
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
