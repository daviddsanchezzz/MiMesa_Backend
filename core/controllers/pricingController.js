const PricingConfig = require('../models/PricingConfig');

// Keep in sync with the landing and the app (settings/shared.jsx).
const DEFAULT_PLANS = [
  {
    id: 'basic',
    name: 'Basic',
    price: 24.99,
    period: 'mes + IVA',
    description: 'Para quien trabaja solo: agenda, reservas online y clientes.',
    featured: false,
    featuredLabel: '',
    cta: 'Probar 14 días gratis',
    ctaStyle: 'outline',
    visible: true,
    order: 0,
    features: [
      { text: '1 profesional', included: true },
      { text: 'Citas, reservas y clientes ilimitados', included: true },
      { text: 'Página de reservas online con tu marca', included: true },
      { text: 'Recordatorios automáticos por email', included: true },
      { text: 'Caja y cobros', included: true },
      { text: 'Sin comisiones por reserva', included: true },
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 39.99,
    period: 'mes + IVA',
    description: 'Para negocios con equipo. Incluye 3 profesionales; cada uno más, 5 €/mes.',
    featured: true,
    featuredLabel: 'Para equipos',
    cta: 'Probar 14 días gratis',
    ctaStyle: 'primary',
    visible: true,
    order: 1,
    features: [
      { text: 'Todo lo de Basic', included: true },
      { text: 'Hasta 3 profesionales (+5 €/mes cada uno más)', included: true },
      { text: 'Agenda, horario y servicios por profesional', included: true },
      { text: '«Te toca volver» y reseñas de Google automáticas', included: true },
      { text: 'Estadísticas por profesional', included: true },
      { text: 'Roles y permisos del equipo', included: true },
    ],
  },
];

// GET /api/pricing/public  — no auth, CORS *
exports.getPublicPricing = async (req, res) => {
  try {
    const config = await PricingConfig.findOne().lean();
    const plans  = config ? config.plans : DEFAULT_PLANS;
    const visible = plans
      .filter(p => p.visible !== false && p.id !== 'free') // no free plan any more: 14-day trial instead
      .sort((a, b) => a.order - b.order);
    res.json(visible);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/dev/pricing  — dev only, returns all plans (incl. hidden)
exports.getDevPricing = async (req, res) => {
  try {
    const config = await PricingConfig.findOne().lean();
    res.json(config ? config.plans : DEFAULT_PLANS);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/dev/pricing  — dev only
exports.upsertPricing = async (req, res) => {
  try {
    const { plans } = req.body;
    if (!Array.isArray(plans)) {
      return res.status(400).json({ message: 'plans debe ser un array' });
    }

    // Assign order by array position if not set
    const normalized = plans.map((p, i) => ({ ...p, order: i }));

    let config = await PricingConfig.findOne();
    if (config) {
      config.plans = normalized;
      await config.save();
    } else {
      config = await PricingConfig.create({ plans: normalized });
    }

    res.json({ plans: config.plans });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
