const Business = require('../models/Business');
const { getModuleAccess } = require('../lib/planCapabilities');

function requireAnyModule(moduleKeys = []) {
  const keys = Array.isArray(moduleKeys) ? moduleKeys.filter(Boolean) : [];

  return async (req, res, next) => {
    try {
      if (!keys.length) return res.status(500).json({ message: 'No hay modulos configurados' });

      const business = await Business.findById(req.businessId)
        .select('plan subscriptionStatus moduleOverrides')
        .lean();

      if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

      const accesses = keys.map((key) => getModuleAccess(business, key));
      const enabled = accesses.find((access) => access.enabled);

      if (!enabled) {
        return res.status(403).json({
          message: 'Este recurso no esta disponible para este restaurante',
          modules: accesses,
          upgradeRequired: accesses.every((access) => !access.allowedByPlan),
        });
      }

      req.moduleAccess = req.moduleAccess || {};
      accesses.forEach((access) => {
        req.moduleAccess[access.moduleKey] = access;
      });

      return next();
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  };
}

module.exports = requireAnyModule;

