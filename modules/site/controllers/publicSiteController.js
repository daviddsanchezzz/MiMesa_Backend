/**
 * The restaurant's data for its website, no session, read only: contact, opening hours (with "open now"),
 * closures, how to book and social links. The menu has its own public endpoint (/api/menu/public).
 */
const mongoose = require('mongoose');
const Business = require('../../../core/models/Business');
const { canUseModule } = require('../../../core/lib/planCapabilities');
const { businessTimezone } = require('../../../core/lib/timezone');
const { businessLogoUrl } = require('../../../core/lib/images');
const { publicBookingUrl } = require('../../../core/lib/publicUrls');
const SiteProfile = require('../models/SiteProfile');
const { scheduleFor } = require('../services/ficha');

/** Handles and phones become links the website can use as they are. */
function socialLinks(s = {}) {
  const handle = (x) => String(x || '').replace(/^@/, '');
  const full = (x, base) => (/^https?:\/\//i.test(x) ? x : `${base}${handle(x)}`);
  const links = [];
  if (s.instagram) links.push({ type: 'instagram', url: full(s.instagram, 'https://www.instagram.com/') });
  if (s.facebook) links.push({ type: 'facebook', url: s.facebook });
  if (s.tiktok) links.push({ type: 'tiktok', url: full(s.tiktok, 'https://www.tiktok.com/@') });
  if (s.youtube) links.push({ type: 'youtube', url: s.youtube });
  if (s.whatsapp) {
    let digits = String(s.whatsapp).replace(/\D/g, '');
    if (digits.length === 9) digits = `34${digits}`;   // a Spanish number without prefix
    if (digits) links.push({ type: 'whatsapp', url: `https://wa.me/${digits}` });
  }
  return links;
}

exports.publicSite = async (req, res) => {
  try {
    const { businessId } = req.params;
    if (!mongoose.isValidObjectId(businessId)) return res.status(404).json({ message: 'Negocio no encontrado' });
    const business = await Business.findById(businessId)
      .select('name phone address email brandColor logoUpdatedAt slug businessType timezone plan subscriptionStatus legacyAccess paymentFailedAt trialEndsAt stripeSubscriptionId moduleOverrides').lean();
    if (!business || !canUseModule(business, 'web')) return res.status(404).json({ message: 'Negocio no encontrado' });

    const profile = await SiteProfile.findOne({ businessId }).lean();
    const timezone = businessTimezone(business);
    const sched = await scheduleFor(businessId, timezone);
    const mode = profile?.reservations?.mode || 'vetra';

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      business: {
        name: business.name, phone: business.phone || '', address: business.address || '', email: business.email || '',
        logoUrl: businessLogoUrl(business), brandColor: business.brandColor || null, timezone,
        // Opens the address in Google Maps; no need to type a link
        mapsUrl: business.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${business.name} ${business.address}`)}` : '',
      },
      // From the turnos, vacations and closures the restaurant already has (Horarios y cierres)
      openingHours: sched.openingHours,
      seasonal: sched.seasonal,
      today: sched.today,
      closures: sched.closures,
      reservations: {
        mode,
        url: mode === 'vetra' ? publicBookingUrl(business) : mode === 'link' ? profile?.reservations?.url || '' : '',
        phone: mode === 'phone' ? business.phone || '' : '',
      },
      // Typed by the restaurant; null when not set (the website shows nothing)
      reviews: profile?.reviews?.rating != null && profile?.reviews?.count != null
        ? { source: 'google', rating: profile.reviews.rating, count: profile.reviews.count, url: profile.reviews.url || '' } : null,
      links: socialLinks(profile?.social),
    });
  } catch (err) {
    console.error('[site] public', err);
    res.status(500).json({ message: 'No se ha podido cargar la ficha' });
  }
};

exports.socialLinks = socialLinks;
