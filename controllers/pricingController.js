const PricingConfig = require('../models/PricingConfig');

const DEFAULT_PLANS = [
  {
    id: 'free',
    name: 'Gratis',
    price: 0,
    period: 'mes',
    description: 'Para empezar y probar sin compromiso.',
    featured: false,
    featuredLabel: '',
    cta: 'Empezar gratis',
    ctaStyle: 'outline',
    visible: true,
    order: 0,
    features: [
      { text: 'Hasta 30 reservas al mes',   included: true },
      { text: '1 sala, hasta 10 mesas',      included: true },
      { text: 'Página de reservas pública',  included: true },
      { text: 'Confirmaciones por email',    included: true },
      { text: 'Varios miembros de equipo',   included: false },
      { text: 'Varias salas',                included: false },
    ],
  },
  {
    id: 'basic',
    name: 'Basic',
    price: 19,
    period: 'mes',
    description: 'Para restaurantes que reciben reservas a diario.',
    featured: true,
    featuredLabel: 'Más popular',
    cta: 'Empezar con Basic',
    ctaStyle: 'primary',
    visible: true,
    order: 1,
    features: [
      { text: 'Reservas ilimitadas',         included: true },
      { text: 'Salas y mesas ilimitadas',    included: true },
      { text: 'Hasta 3 miembros de equipo',  included: true },
      { text: 'Confirmaciones por email',    included: true },
      { text: 'Base de clientes',            included: true },
      { text: 'Miembros ilimitados',         included: false },
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 39,
    period: 'mes',
    description: 'Para grupos, franquicias y establecimientos con alto volumen.',
    featured: false,
    featuredLabel: '',
    cta: 'Empezar con Pro',
    ctaStyle: 'outline',
    visible: true,
    order: 2,
    features: [
      { text: 'Todo lo de Basic',              included: true },
      { text: 'Miembros de equipo ilimitados', included: true },
      { text: 'Soporte prioritario',           included: true },
      { text: 'Exportación de datos',          included: true },
      { text: 'Color de marca personalizado',  included: true },
      { text: 'Próximamente: API acceso',      included: true },
    ],
  },
];

// GET /api/pricing/public  — no auth, CORS *
exports.getPublicPricing = async (req, res) => {
  try {
    const config = await PricingConfig.findOne().lean();
    const plans  = config ? config.plans : DEFAULT_PLANS;
    const visible = plans
      .filter(p => p.visible !== false)
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
