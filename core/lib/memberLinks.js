/**
 * Things a new team member is linked to when they join, chosen on the
 * invitation (e.g. "this person is the professional Laura in the agenda").
 * Modules register the kinds they understand (core cannot import them):
 *
 *   registerMemberLink({
 *     key: 'resourceId',
 *     validate: async ({ businessId, value, email }) => normalizedValue,  // throw MemberLinkError if invalid
 *     apply:    async ({ businessId, userId, value }) => {},       // when the invitation is accepted
 *   })
 */
const kinds = new Map();

function registerMemberLink(kind) {
  if (!kind?.key || typeof kind.validate !== 'function' || typeof kind.apply !== 'function') {
    throw new Error('Invalid member link');
  }
  kinds.set(kind.key, kind);
}

class MemberLinkError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Keeps only known, non-empty links, each validated by its module. */
async function validateLinks(businessId, links, context = {}) {
  const out = {};
  if (!links || typeof links !== 'object' || Array.isArray(links)) return out;
  for (const [key, value] of Object.entries(links)) {
    if (value === null || value === undefined || value === '') continue;
    const kind = kinds.get(key);
    if (!kind) continue;
    out[key] = await kind.validate({ businessId, value, ...context });
  }
  return out;
}

/** Applies every link; one failing does not stop the others (nor the join). */
async function applyLinks({ businessId, userId, links }) {
  const applied = [];
  for (const [key, value] of Object.entries(links || {})) {
    const kind = kinds.get(key);
    if (!kind) continue;
    try {
      await kind.apply({ businessId, userId, value });
      applied.push(key);
    } catch (err) {
      console.error(`[memberLinks] ${key} not applied:`, err.message);
    }
  }
  return applied;
}

async function removeLinks({ businessId, userId }) {
  for (const kind of kinds.values()) {
    if (kind.remove) await kind.remove({ businessId, userId });
  }
}

module.exports = { registerMemberLink, validateLinks, applyLinks, removeLinks, MemberLinkError };
