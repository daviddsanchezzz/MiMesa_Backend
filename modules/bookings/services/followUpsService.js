/**
 * Follow-up emails after visits ("te toca volver" and review requests).
 * Settings are per business and off by default. Every email is claimed on the
 * booking before sending (reviewRequestedAt / rebookReminderSentAt), so two
 * server instances never send the same one and a customer gets at most one
 * of each per visit.
 */
const Business = require('../../../core/models/Business');
const Customer = require('../../../core/models/Customer');
const { businessTimezone, dateInTimezone } = require('../../../core/lib/timezone');
const Booking = require('../models/Booking');
const FollowUpSettings = require('../models/FollowUpSettings');
const { BookingError } = require('../lib/errors');
const { rebookTarget, reviewDue, REVIEW_MAX_AGE_HOURS, REVIEW_COOLDOWN_DAYS } = require('../lib/followUps');
const { sendFollowUp } = require('./bookingEmails');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NEVER = new Date(0); // "handled, nothing sent" (opted out, no email…)
const REBOOK_LOOKBACK_DAYS = 240;
const REBOOK_FROM_HOUR = 10; // local time: people get it in the morning, once a day
const MAX_PER_RUN = 50;

// ── Settings ────────────────────────────────────────────────────────────────
function shapeSettings(doc) {
  return {
    rebook: { enabled: !!doc?.rebook?.enabled },
    review: { enabled: !!doc?.review?.enabled, url: doc?.review?.url || '', delayHours: doc?.review?.delayHours || 3 },
  };
}

async function getSettings(businessId) {
  const [doc, sentReview, sentRebook] = await Promise.all([
    FollowUpSettings.findOne({ businessId }).lean(),
    Booking.countDocuments({ businessId, reviewRequestedAt: { $gt: new Date(Date.now() - 30 * DAY) } }),
    Booking.countDocuments({ businessId, rebookReminderSentAt: { $gt: new Date(Date.now() - 30 * DAY) } }),
  ]);
  return { ...shapeSettings(doc), sentLast30Days: { review: sentReview, rebook: sentRebook } };
}

function settingsInput(body = {}) {
  const bad = (m) => { throw new BookingError(400, m, 'BAD_REQUEST'); };
  const bool = (v, name) => { if (typeof v !== 'boolean') bad(`${name} no es válido`); return v; };
  const out = {};
  if (body.rebook !== undefined) out['rebook.enabled'] = bool(body.rebook?.enabled, 'Te toca volver');
  if (body.review !== undefined) {
    const r = body.review || {};
    if (r.enabled !== undefined) out['review.enabled'] = bool(r.enabled, 'Pedir opinión');
    if (r.url !== undefined) {
      const url = String(r.url || '').trim();
      if (url && (!/^https:\/\/\S+$/i.test(url) || url.length > 500)) bad('El enlace de reseñas debe empezar por https://');
      out['review.url'] = url;
    }
    if (r.delayHours !== undefined) {
      const n = Number(r.delayHours);
      if (!Number.isInteger(n) || n < 1 || n > 48) bad('Las horas de espera deben estar entre 1 y 48');
      out['review.delayHours'] = n;
    }
  }
  return out;
}

async function saveSettings(businessId, body) {
  const set = settingsInput(body);
  const current = shapeSettings(await FollowUpSettings.findOne({ businessId }).lean());
  const reviewOn = set['review.enabled'] ?? current.review.enabled;
  const url = set['review.url'] ?? current.review.url;
  if (reviewOn && !url) throw new BookingError(400, 'Pega el enlace de tu ficha de Google para pedir opiniones', 'BAD_REQUEST');
  await FollowUpSettings.updateOne({ businessId }, { $set: set, $setOnInsert: { businessId } }, { upsert: true });
  return getSettings(businessId);
}

// ── Review requests ─────────────────────────────────────────────────────────
async function customerFor(booking) {
  if (!booking.customerId) return null;
  return Customer.findById(booking.customerId).select('name email marketingUnsubscribed unsubscribeToken').lean();
}

async function runReviewRequests(now = new Date()) {
  let sent = 0;
  const all = await FollowUpSettings.find({ 'review.enabled': true, 'review.url': { $ne: '' } }).lean();
  for (const s of all) {
    const delay = s.review.delayHours || 3;
    const candidates = await Booking.find({
      businessId: s.businessId,
      reviewRequestedAt: null,
      end: { $gte: new Date(now.getTime() - REVIEW_MAX_AGE_HOURS * HOUR), $lte: new Date(now.getTime() - delay * HOUR) },
      $or: [{ status: 'completed' }, { payment: { $ne: null } }],
    }).limit(MAX_PER_RUN).lean();
    for (const b of candidates) {
      const customer = await customerFor(b);
      if (!customer || customer.marketingUnsubscribed || !(customer.email || b.guestEmail)) {
        await Booking.updateOne({ _id: b._id, reviewRequestedAt: null }, { $set: { reviewRequestedAt: NEVER } });
        continue;
      }
      const recent = await Booking.find({
        businessId: s.businessId, customerId: b.customerId, reviewRequestedAt: { $gt: new Date(now.getTime() - REVIEW_COOLDOWN_DAYS * DAY) },
      }).select('reviewRequestedAt').lean();
      if (!reviewDue(b, recent, now, delay)) {
        if (recent.length) await Booking.updateOne({ _id: b._id, reviewRequestedAt: null }, { $set: { reviewRequestedAt: NEVER } });
        continue;
      }
      const claimed = await Booking.updateOne({ _id: b._id, reviewRequestedAt: null }, { $set: { reviewRequestedAt: now } });
      if (!claimed.modifiedCount) continue;
      if (await sendFollowUp('review', { booking: b, customer, reviewUrl: s.review.url })) sent++;
      else await Booking.updateOne({ _id: b._id, reviewRequestedAt: now }, { $set: { reviewRequestedAt: null } });
    }
  }
  if (sent) console.log(`[scheduler] review requests: ${sent} sent`);
  return { sent };
}

// ── "Te toca volver" ────────────────────────────────────────────────────────
async function runRebookReminders(now = new Date()) {
  let sent = 0;
  const all = await FollowUpSettings.find({ 'rebook.enabled': true }).lean();
  for (const s of all) {
    const business = await Business.findById(s.businessId).select('timezone').lean();
    if (!business) continue;
    const tz = businessTimezone(business);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now));
    const today = dateInTimezone(now, tz);
    if (hour < REBOOK_FROM_HOUR || s.rebook.lastRunDate === today) continue;
    // Once a day per business
    const claimed = await FollowUpSettings.updateOne(
      { _id: s._id, 'rebook.lastRunDate': { $ne: today } }, { $set: { 'rebook.lastRunDate': today } },
    );
    if (!claimed.modifiedCount) continue;

    const since = new Date(now.getTime() - REBOOK_LOOKBACK_DAYS * DAY);
    const customerIds = await Booking.distinct('customerId', {
      businessId: s.businessId, customerId: { $ne: null }, start: { $gte: since, $lte: now },
      $or: [{ status: 'completed' }, { payment: { $ne: null } }],
    });
    let sentHere = 0;
    for (const customerId of customerIds) {
      if (sentHere >= MAX_PER_RUN) break;
      const customer = await Customer.findById(customerId).select('name email marketingUnsubscribed unsubscribeToken').lean();
      if (!customer || customer.marketingUnsubscribed) continue;
      const bookings = await Booking.find({ businessId: s.businessId, customerId })
        .select('status start end payment rebookReminderSentAt guestEmail').lean();
      const target = rebookTarget(bookings, now);
      if (!target || !(customer.email || target.guestEmail)) continue;
      const ok = await Booking.updateOne({ _id: target._id, rebookReminderSentAt: null }, { $set: { rebookReminderSentAt: now } });
      if (!ok.modifiedCount) continue;
      const full = await Booking.findById(target._id).lean();
      if (await sendFollowUp('rebook', { booking: full, customer })) { sent++; sentHere++; }
      else await Booking.updateOne({ _id: target._id, rebookReminderSentAt: now }, { $set: { rebookReminderSentAt: null } });
    }
  }
  if (sent) console.log(`[scheduler] rebook reminders: ${sent} sent`);
  return { sent };
}

module.exports = { getSettings, saveSettings, runReviewRequests, runRebookReminders, settingsInput };
