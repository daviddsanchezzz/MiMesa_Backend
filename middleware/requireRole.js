/**
 * requireRole(minRole)
 *
 * Returns a middleware that enforces a minimum role level.
 * Must run AFTER requireAuth and requireBusinessAccess.
 *
 * Role hierarchy: owner (3) > manager (2) > staff (1)
 *
 * Usage:
 *   router.delete('/:id', requireAuth, requireRole('owner'), handler);
 *   router.put('/:id',    requireAuth, requireRole('manager'), handler);
 */

const BusinessMember = require('../models/BusinessMember');

const HIERARCHY = { owner: 3, manager: 2, staff: 1 };

module.exports = function requireRole(minRole) {
  return async (req, res, next) => {
    // Legacy JWT users are implicit owners — full access during migration
    if (!req.user) return next();

    // Resolve role if not already set (requireBusinessAccess may not have run)
    if (!req.memberRole) {
      const member = await BusinessMember.findOne({
        userId:     req.user.id,
        businessId: req.businessId,
      });
      if (!member) return res.status(403).json({ message: 'Sin acceso a este restaurante' });
      req.memberRole = member.role;
    }

    const userLevel = HIERARCHY[req.memberRole] ?? 0;
    const minLevel  = HIERARCHY[minRole] ?? 0;

    if (userLevel < minLevel) {
      return res.status(403).json({
        message: `Se requiere rol '${minRole}' o superior`,
        yourRole: req.memberRole,
      });
    }

    next();
  };
};
