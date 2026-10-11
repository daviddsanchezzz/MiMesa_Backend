/**
 * Marketing consent of a customer. Opting in records when and how they agreed;
 * a customer who unsubscribed (or was recorded as not wanting emails) is never
 * subscribed again behind their back.
 */
const crypto = require('crypto');
const Customer = require('../models/Customer');

/** Subscribes the customer. Returns true when they end up subscribed. */
async function optIn(customerId, source) {
  const customer = await Customer.findById(customerId).select('unsubscribeToken marketingUnsubscribed marketingSubscribed');
  if (!customer || customer.marketingUnsubscribed) return false;
  if (customer.marketingSubscribed) return true;
  const set = { marketingSubscribed: true, marketingSubscribedAt: new Date(), marketingConsentSource: source };
  if (!customer.unsubscribeToken) set.unsubscribeToken = crypto.randomBytes(32).toString('hex');
  await Customer.updateOne({ _id: customerId }, { $set: set });
  return true;
}

/** Records that the customer does not want commercial emails. */
async function optOut(customerId) {
  await Customer.updateOne({ _id: customerId }, { $set: { marketingSubscribed: false, marketingUnsubscribed: true, marketingUnsubscribedAt: new Date() } });
}

module.exports = { optIn, optOut };
