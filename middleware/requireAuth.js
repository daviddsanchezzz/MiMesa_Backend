/**
 * requireAuth — combined middleware
 *
 * Checks authentication in two layers:
 *  1. Better Auth session cookie (new system)
 *  2. JWT Bearer token (legacy fallback — kept during migration)
 *
 * Sets req.businessId so all existing route handlers keep working unchanged.
 */

const jwt = require('jsonwebtoken');
const { fromNodeHeaders } = require('better-auth/node');
const { getAuth } = require('../lib/auth');
const Business = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');

module.exports = async function requireAuth(req, res, next) {
  // ── 1. Better Auth session ──────────────────────────────────────────────
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (session?.user) {
      let business = await Business.findOne({ ownerId: session.user.id });

      // Migration fallback: legacy Business with same email but no ownerId yet
      if (!business) {
        business = await Business.findOne({ email: session.user.email.toLowerCase() });
        if (business) {
          // Link on the fly (runs once per user)
          business.ownerId = session.user.id;
          await business.save().catch(() => {});
        }
      }

      if (business) {
        // Resolve membership role in the same request (avoids extra round-trip in requireRole)
        const member = await BusinessMember.findOne({
          userId:     session.user.id,
          businessId: business._id,
        });
        req.user       = session.user;
        req.businessId = business._id.toString();
        req.memberRole = member?.role ?? 'owner'; // 'owner' as safe default during migration
        return next();
      }
      return res.status(403).json({ message: 'Cuenta sin negocio asociado' });
    }
  } catch {
    // Better Auth not initialized or session check failed — fall through to JWT
  }

  // ── 2. JWT Bearer fallback (legacy) ────────────────────────────────────
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.businessId = decoded.id;
      return next();
    } catch {
      // Invalid / expired JWT
    }
  }

  return res.status(401).json({ message: 'No autorizado' });
};
