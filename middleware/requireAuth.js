/**
 * requireAuth — combined middleware
 *
 * Authentication: Better Auth session (cookie or bearer token).
 *
 * Business resolution (Membership is the source of truth):
 *  - If X-Business-Id header present → validate user has active membership there
 *  - Otherwise → auto-select first (oldest) active membership
 *
 * Sets: req.user, req.businessId, req.memberRole, req.isDev
 */

const { fromNodeHeaders } = require('better-auth/node');
const { getAuth }    = require('../lib/auth');
const BusinessMember = require('../models/BusinessMember');
const { isDev }      = require('./requireDev');

module.exports = async function requireAuth(req, res, next) {
  try {
    const auth    = getAuth();
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

    if (session?.user) {
      req.user = session.user;
      if (isDev(session.user.email)) req.isDev = true;

      // Resolve which business to operate on
      const requestedId = req.headers['x-business-id'];

      // status: { $ne: 'invited' } matches both 'active' AND documents without the field
      // (existing records created before the status field was added)
      const activeFilter = { status: { $ne: 'invited' } };

      let membership;
      if (requestedId) {
        membership = await BusinessMember.findOne({
          userId:     session.user.id,
          businessId: requestedId,
          ...activeFilter,
        });
        if (!membership) {
          membership = await BusinessMember.findOne({
            userId: session.user.id,
            ...activeFilter,
          }).sort({ createdAt: 1 });
        }
      } else {
        membership = await BusinessMember.findOne({
          userId: session.user.id,
          ...activeFilter,
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
  } catch (err) {
    console.error('[requireAuth] session check failed:', err.message);
    return res.status(503).json({ message: 'Servicio de autenticación no disponible, inténtalo de nuevo' });
  }

  return res.status(401).json({ message: 'No autorizado' });
};
