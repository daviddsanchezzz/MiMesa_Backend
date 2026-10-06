const mongoose = require('mongoose');
const SiteProfile = require('../models/SiteProfile');
const v = require('../lib/validation');
const { rangesOf } = require('../lib/hours');

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof v.SiteError) return res.status(err.status).json({ message: err.message });
      console.error('[site]', err);
      res.status(500).json({ message: 'Algo ha fallado. Inténtalo de nuevo.' });
    }
  };
}

const EMPTY_WEEK = () => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, ranges: [] }));

/** The saved profile, or an empty one: every day closed, nothing to book with. */
function withDefaults(doc) {
  const p = doc || {};
  return {
    openingHours: p.openingHours?.length ? p.openingHours : EMPTY_WEEK(),
    closures: p.closures || [],
    reservations: { mode: p.reservations?.mode || 'none', url: p.reservations?.url || '' },
    social: { instagram: '', facebook: '', tiktok: '', youtube: '', whatsapp: '', ...(p.social || {}) },
    contactEmail: p.contactEmail || '',
    mapsUrl: p.mapsUrl || '',
  };
}

exports.getProfile = handle(async (req, res) => {
  res.json(withDefaults(await SiteProfile.findOne({ businessId: req.businessId }).lean()));
});

exports.saveProfile = handle(async (req, res) => {
  const data = v.profile(req.body);
  const doc = await SiteProfile.findOneAndUpdate({ businessId: req.businessId }, { $set: data }, { upsert: true, new: true }).lean();
  res.json(withDefaults(doc));
});

/**
 * Hours and closures worked out from what the restaurant already has for reservations (turnos and
 * vacations), so someone who uses them does not type everything twice. It only suggests: nothing is
 * saved. The customer-facing times of a turno are used, never the staff times.
 * Models of the restaurant vertical are looked up by name (a module cannot import a vertical).
 */
exports.hoursSuggestion = handle(async (req, res) => {
  const Shift = mongoose.models.Shift;
  const Vacation = mongoose.models.Vacation;
  const week = EMPTY_WEEK();
  if (Shift) {
    const shifts = await Shift.find({ businessId: req.businessId, $or: [{ startDate: null }, { startDate: '' }, { startDate: { $exists: false } }] }).lean();
    for (const s of shifts) {
      for (const day of s.days || []) {
        const target = week.find((d) => d.day === day);
        if (target && s.startTime && s.endTime && s.startTime !== s.endTime) target.ranges.push({ open: s.startTime, close: s.endTime === '00:00' ? '24:00' : s.endTime });
      }
    }
    for (const d of week) d.ranges.sort((a, b) => a.open.localeCompare(b.open));
  }
  const today = new Date().toISOString().slice(0, 10);
  const closures = Vacation
    ? (await Vacation.find({ businessId: req.businessId, endDate: { $gte: today } }).sort({ startDate: 1 }).lean())
      .map((x) => ({ from: x.startDate, to: x.endDate, reason: x.reason || '' }))
    : [];
  res.json({ openingHours: week, closures, found: week.some((d) => rangesOf(week, d.day).length) || closures.length > 0 });
});
