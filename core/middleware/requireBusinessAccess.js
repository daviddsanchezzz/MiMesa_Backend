/**
 * requireBusinessAccess
 *
 * Verifies the authenticated user is a member of the requested business
 * and attaches req.memberRole.
 *
 * Must run AFTER requireAuth (which sets req.user and req.businessId).
 */

const BusinessMember = require('../models/BusinessMember');

module.exports = async function requireBusinessAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ message: 'No autorizado' });

  // Already resolved by requireAuth (batch lookup)
  if (req.memberRole) return next();

  const member = await BusinessMember.findOne({
    userId:     req.user.id,
    businessId: req.businessId,
  });

  if (!member) {
    return res.status(403).json({ message: 'Sin acceso a este negocio' });
  }

  req.memberRole = member.role;
  next();
};
