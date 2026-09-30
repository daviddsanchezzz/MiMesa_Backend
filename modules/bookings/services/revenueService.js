/**
 * Revenue of an appointment business for a date range, for Finanzas:
 * what the attended appointments are worth, what was actually charged at the
 * till, and each professional's share and commission. Euros (not cents), as
 * the finance module works in euros.
 */
const Business = require('../../../core/models/Business');
const { businessTimezone, dateInTimezone } = require('../../../core/lib/timezone');
const Booking = require('../models/Booking');
const Resource = require('../models/Resource');
const Service = require('../models/Service');
const { localToUtc } = require('../lib/availability');
const { addDaysToDate } = require('../lib/schedule');

const euros = (cents) => Math.round(cents) / 100;

function summarize({ bookings, payments, staff, commissionByService, tz, now }) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const byDate = {};
  const day = (d) => (byDate[d] ||= { appointments: 0, billed: 0, collected: 0, tips: 0, payments: 0 });
  const staffIds = new Set(staff.map((s) => String(s._id)));
  const byStaff = new Map(staff.map((s) => [String(s._id), { id: String(s._id), name: s.name, color: s.color || null, appointments: 0, billed: 0, commission: 0 }]));

  for (const b of bookings) {
    if (['cancelled', 'no_show', 'pending'].includes(b.status)) continue;
    const attended = b.status === 'completed' || b.status === 'checked_in' || new Date(b.end) <= now;
    if (!attended) continue;
    const d = day(fmt.format(new Date(b.start)));
    d.appointments += 1;
    d.billed += b.totalPrice || 0;
    const seen = new Set();
    for (const seg of b.segments || []) {
      const ids = (seg.resourceIds || []).map(String).filter((id) => staffIds.has(id));
      for (const id of ids) {
        const row = byStaff.get(id);
        const share = (seg.price || 0) / ids.length;
        row.billed += share;
        row.commission += share * ((commissionByService[String(seg.serviceId)] || 0) / 100);
        if (!seen.has(id)) { row.appointments += 1; seen.add(id); }
      }
    }
  }
  for (const b of payments) {
    const d = day(b.payment.date);
    d.collected += b.payment.total;
    d.tips += b.payment.tip || 0;
    d.payments += 1;
  }
  const out = {};
  for (const [date, v] of Object.entries(byDate)) {
    out[date] = { appointments: v.appointments, billed: euros(v.billed), collected: euros(v.collected), tips: euros(v.tips), payments: v.payments };
  }
  return {
    byDate: out,
    byStaff: [...byStaff.values()].map((r) => ({ ...r, billed: euros(r.billed), commission: euros(r.commission) }))
      .sort((a, b) => b.billed - a.billed),
  };
}

async function appointmentRevenue(businessId, from, to, now = new Date()) {
  const business = await Business.findById(businessId).select('timezone').lean();
  const tz = businessTimezone(business);
  const [bookings, payments, staff, services] = await Promise.all([
    Booking.find({
      businessId,
      start: { $gte: localToUtc(from, 0, tz), $lt: localToUtc(addDaysToDate(to, 1), 0, tz) },
    }).select('status start end totalPrice segments').lean(),
    Booking.find({ businessId, 'payment.date': { $gte: from, $lte: to } }).select('payment').lean(),
    Resource.find({ businessId, kind: 'staff' }).select('name color active sortOrder').sort({ sortOrder: 1, name: 1 }).lean(),
    Service.find({ businessId }).select('staffCommissionPercent').lean(),
  ]);
  const commissionByService = Object.fromEntries(services.map((s) => [String(s._id), s.staffCommissionPercent || 0]));
  const result = summarize({ bookings, payments, staff, commissionByService, tz, now });
  // Hide deactivated people who did nothing in the period
  result.byStaff = result.byStaff.filter((r) => r.billed > 0 || staff.find((s) => String(s._id) === r.id)?.active !== false);
  return { ...result, today: dateInTimezone(now, tz) };
}

module.exports = { appointmentRevenue, summarize };
