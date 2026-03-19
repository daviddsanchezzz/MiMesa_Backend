/**
 * requireBusinessAccess
 *
 * Verifies the authenticated user is a member of the requested business
 * and attaches req.memberRole.
 *
 * Must run AFTER requireAuth (which sets req.user and req.businessId).
 *
 * Legacy JWT path (req.user is null) is treated as implicit owner —
 * this path disappears once all users migrate to Better Auth.
 */

const BusinessMember = require('../models/BusinessMember');

module.exports = async function requireBusinessAccess(req, res, next) {
  // Legacy JWT: requireAuth already validated the businessId ownership
  if (!req.user) return next();

  // Already resolved by requireAuth (batch lookup)
  if (req.memberRole) return next();

  const member = await BusinessMember.findOne({
    userId:     req.user.id,
    businessId: req.businessId,
  });

  if (!member) {
    return res.status(403).json({ message: 'Sin acceso a este restaurante' });
  }

  req.memberRole = member.role;
  next();
};
