/**
 * Everything stored for a business, per module, so deleting a business really
 * deletes its data (RGPD) and leaves nothing behind. Modules register what
 * they own (core cannot import them):
 *
 *   registerBusinessData({ key: 'bookings', erase: async (businessId) => ({ Booking: n, … }) })
 */
const kinds = new Map();

function registerBusinessData(kind) {
  if (!kind?.key || typeof kind.erase !== 'function') throw new Error('Invalid business data handler');
  kinds.set(kind.key, kind);
}

async function eraseModuleData(businessId) {
  const out = {};
  for (const k of kinds.values()) out[k.key] = await k.erase(businessId);
  return out;
}

/** Counts per collection after deleting everything owned by `models`. */
async function deleteAllFor(businessId, models) {
  const counts = {};
  for (const [name, Model] of Object.entries(models)) {
    const r = await Model.deleteMany({ businessId });
    counts[name] = r.deletedCount || 0;
  }
  return counts;
}

module.exports = { registerBusinessData, eraseModuleData, deleteAllFor, _kinds: kinds };
