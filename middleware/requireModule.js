const Business = require('../models/Business');
const { getModuleAccess } = require('../lib/planCapabilities');

function requireModule(moduleKey) {
  return async (req, res, next) => {
    try {
      const business = await Business.findById(req.businessId)
        .select('plan subscriptionStatus moduleOverrides')
        .lean();

      if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

      const access = getModuleAccess(business, moduleKey);
      if (!access.enabled) {
        return res.status(403).json({
          message: 'Este modulo no esta disponible para este restaurante',
          module: moduleKey,
          moduleAccess: access,
          upgradeRequired: !access.allowedByPlan,
        });
      }

      req.moduleAccess = req.moduleAccess || {};
      req.moduleAccess[moduleKey] = access;
      next();
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  };
}

module.exports = requireModule;
