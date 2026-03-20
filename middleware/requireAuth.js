/**
 * requireAuth — combined middleware
 *
 * Authentication flow:
 *  1. Better Auth session cookie (primary)
 *  2. JWT Bearer token (legacy fallback)
 *
 * Business resolution (Membership is the source of truth):
 *  - If X-Business-Id header present → validate user has active membership there
 *  - Otherwise → auto-select first (oldest) active membership
 *
 * Sets: req.user, req.businessId, req.memberRole, req.isDev
 */

const jwt            = require('jsonwebtoken');
const { fromNodeHeaders } = require('better-auth/node');
const { getAuth }    = require('../lib/auth');
const BusinessMember = require('../models/BusinessMember');
const { isDev }      = require('./requireDev');

module.exports = async function requireAuth(req, res, next) {
  // ── 1. Better Auth session ──────────────────────────────────────────────
  try {
    const auth    = getAuth();
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

    if (session?.user) {
      req.user = session.user;
      if (isDev(session.user.email)) req.isDev = true;

      // Resolve which business to operate on
      const requestedId = req.headers['x-business-id'];

      let membership;
      if (requestedId) {
        // Validate the user actually belongs to the requested business
        membership = await BusinessMember.findOne({
          userId:     session.user.id,
          businessId: requestedId,
          status:     'active',
        });
        // Graceful fallback: use their first business if header is stale/invalid
        if (!membership) {
          membership = await BusinessMember.findOne({
            userId: session.user.id,
            status: 'active',
          }).sort({ createdAt: 1 });
        }
      } else {
        membership = await BusinessMember.findOne({
          userId: session.user.id,
          status: 'active',
        }).sort({ createdAt: 1 });
      }

      if (membership) {
        req.businessId = membership.businessId.toString();
        req.memberRole = membership.role;
        return next();
      }

      // Dev users can proceed without a business (for the /dev console)
      if (req.isDev) return next();

      return res.status(403).json({ message: 'Cuenta sin negocio asociado' });
    }
  } catch {
    // Better Auth not initialized or session check failed — fall through to JWT
  }

  // ── 2. JWT Bearer fallback (legacy) ────────────────────────────────────
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const decoded  = jwt.verify(token, process.env.JWT_SECRET);
      req.businessId = decoded.id;
      return next();
    } catch {
      // Invalid / expired JWT
    }
  }

  return res.status(401).json({ message: 'No autorizado' });
};
