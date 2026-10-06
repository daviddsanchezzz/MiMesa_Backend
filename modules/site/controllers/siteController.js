const SiteProfile = require('../models/SiteProfile');
const Business = require('../../../core/models/Business');
const { businessTimezone } = require('../../../core/lib/timezone');
const v = require('../lib/validation');
const { scheduleFor } = require('../services/ficha');

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

/** The saved profile, or the defaults: bookings through Vetra, no social links. */
function withDefaults(doc) {
  const p = doc || {};
  return {
    reservations: { mode: p.reservations?.mode || 'vetra', url: p.reservations?.url || '' },
    social: { instagram: '', facebook: '', tiktok: '', youtube: '', whatsapp: '', ...(p.social || {}) },
  };
}

// The profile plus how the website currently shows the schedule (read-only: it comes from Horarios y cierres)
async function respond(businessId, doc) {
  const business = await Business.findById(businessId).select('timezone phone address email').lean();
  return {
    ...withDefaults(doc),
    schedule: await scheduleFor(businessId, businessTimezone(business)),
    business: { phone: business?.phone || '', address: business?.address || '', email: business?.email || '' },
  };
}

exports.getProfile = handle(async (req, res) => {
  res.json(await respond(req.businessId, await SiteProfile.findOne({ businessId: req.businessId }).lean()));
});

exports.saveProfile = handle(async (req, res) => {
  const data = v.profile(req.body);
  const doc = await SiteProfile.findOneAndUpdate({ businessId: req.businessId }, { $set: data }, { upsert: true, new: true }).lean();
  res.json(await respond(req.businessId, doc));
});
