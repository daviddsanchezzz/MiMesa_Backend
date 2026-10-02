/**
 * Gives a slug to every business that still has none (businesses created
 * before slugs existed). Idempotent; runs at startup.
 */
const Business = require('../models/Business');
const { uniqueSlugFor } = require('../lib/slugs');

async function ensureBusinessSlugs({ log = console } = {}) {
  const missing = await Business.find({ $or: [{ slug: { $exists: false } }, { slug: null }, { slug: '' }] })
    .select('_id name').sort({ createdAt: 1 }).lean();
  let done = 0;
  for (const b of missing) {
    const slug = await uniqueSlugFor(Business, b.name, b._id);
    await Business.updateOne({ _id: b._id, $or: [{ slug: { $exists: false } }, { slug: null }, { slug: '' }] }, { $set: { slug } });
    done += 1;
  }
  if (done) log.info?.(`[slugs] assigned ${done} business slug(s)`);
  return done;
}

module.exports = { ensureBusinessSlugs };
