/**
 * Small images (logos, staff photos) are resized in the browser and stored as
 * data URLs. Keeps the stack simple: no file storage service.
 */
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

/** Returns { value } (null = remove) or { error }. */
function checkImageDataUrl(value, { label = 'La imagen', maxChars = 200 * 1024 } = {}) {
  if (value === null || value === '') return { value: null };
  if (typeof value !== 'string' || !IMAGE_DATA_URL.test(value)) return { error: `${label} debe ser una imagen PNG, JPG o WebP` };
  if (value.length > maxChars) return { error: `${label} es demasiado grande` };
  return { value };
}

/** { contentType, buffer } from a stored data URL, or null. */
function decodeImageDataUrl(value) {
  const m = IMAGE_DATA_URL.exec(value || '');
  return m ? { contentType: m[1], buffer: Buffer.from(m[2], 'base64') } : null;
}

/** Public URL of a business logo (app, booking page, emails), or null. */
function businessLogoUrl(business) {
  if (!business?.logoUpdatedAt) return null;
  const base = (process.env.BACKEND_URL || '').replace(/\/$/, '');
  return `${base}/api/auth/public/business/${business._id}/logo?v=${new Date(business.logoUpdatedAt).getTime()}`;
}

module.exports = { checkImageDataUrl, decodeImageDataUrl, businessLogoUrl };
