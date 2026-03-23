/**
 * requirePlan(feature) — middleware factory
 *
 * Blocks the request with 403 if the business's effective plan does not
 * include the named feature. Requires requireAuth to run first (sets req.businessId).
 *
 * Usage:
 *   router.post('/send', requireAuth, requirePlan('marketing'), handler)
 */

const Business           = require('../models/Business');
const { getCapabilities } = require('../lib/planCapabilities');

function requirePlan(feature) {
  return async (req, res, next) => {
    try {
      const business = await Business.findById(req.businessId).select('plan subscriptionStatus').lean();
      if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

      const caps = getCapabilities(business);
      if (!caps[feature]) {
        return res.status(403).json({
          message:         'Esta función requiere el plan Basic',
          feature,
          upgradeRequired: true,
          currentPlan:     caps.id,
        });
      }
      next();
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  };
}

module.exports = requirePlan;
