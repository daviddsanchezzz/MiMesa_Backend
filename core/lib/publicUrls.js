/**
 * Public booking page of a business.
 *
 *   production  https://vetrareserve.com/{slug}
 *   elsewhere   {FRONTEND_URL}/r/{slug}   (dev, local)
 *
 * PUBLIC_SITE_URL overrides the base. Businesses without a slug yet fall back
 * to the old /public/{id}/… address, which still works.
 */

function frontendUrl() {
  return (process.env.FRONTEND_URL || process.env.APP_URL || 'https://app.vetrareserve.com').replace(/\/+$/, '');
}

function publicSiteBase() {
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/+$/, '');
  const app = frontendUrl();
  if (/^https:\/\/app\.vetrareserve\.com$/i.test(app)) return 'https://vetrareserve.com';
  return `${app}/r`;
}

function legacyPublicUrl(business) {
  const path = business?.businessType === 'appointments' ? 'cita' : 'reserve';
  return `${frontendUrl()}/public/${business?._id || business?.id}/${path}`;
}

function publicBookingUrl(business) {
  if (business?.slug) return `${publicSiteBase()}/${business.slug}`;
  return legacyPublicUrl(business);
}

module.exports = { publicSiteBase, publicBookingUrl, legacyPublicUrl, frontendUrl };
