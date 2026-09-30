/**
 * Who gets the follow-up emails. Pure functions over a customer's bookings,
 * so the legal rules are unit-tested:
 *  - only people who really came (an appointment completed or charged),
 *  - at most one "te toca volver" per visit and nothing if they already booked,
 *  - review requests shortly after the visit, not for old visits, and not more
 *    than once every REVIEW_COOLDOWN_DAYS for regulars,
 *  - everyone is asked for a review, happy or not (Google forbids filtering).
 */
const { summarizeCustomer } = require('./customers');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const REVIEW_MAX_AGE_HOURS = 48;
const REVIEW_COOLDOWN_DAYS = 120;

const reallyCame = (b) => b.status === 'completed' || !!b.payment;

/**
 * The visit to attach a "te toca volver" email to, or null.
 * bookings: all of one customer's bookings (any status).
 */
function rebookTarget(bookings, now = new Date()) {
  if (!bookings.some(reallyCame)) return null;
  const summary = summarizeCustomer(bookings, now);
  if (!summary.dueBack) return null;
  // Their last visit (the one the rhythm is measured from)
  const last = bookings
    .filter((b) => !['cancelled', 'no_show'].includes(b.status) && new Date(b.end) <= now)
    .sort((a, b) => new Date(b.start) - new Date(a.start))[0];
  if (!last || last.rebookReminderSentAt) return null;
  return last;
}

/** Whether to ask for a review for this booking now. */
function reviewDue(booking, customerBookings, now = new Date(), delayHours = 3) {
  if (!reallyCame(booking) || booking.reviewRequestedAt) return false;
  const end = new Date(booking.end).getTime();
  if (now.getTime() < end + delayHours * HOUR) return false;
  if (now.getTime() > end + REVIEW_MAX_AGE_HOURS * HOUR) return false;
  const cooldownStart = now.getTime() - REVIEW_COOLDOWN_DAYS * DAY;
  return !customerBookings.some((b) => b.reviewRequestedAt && new Date(b.reviewRequestedAt).getTime() > cooldownStart);
}

module.exports = { rebookTarget, reviewDue, reallyCame, REVIEW_MAX_AGE_HOURS, REVIEW_COOLDOWN_DAYS };
