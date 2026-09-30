/**
 * Starting points for appointment businesses. Vetra applies one when it
 * creates a business for a client, so the owner's first login already shows a
 * working agenda: one professional (the owner), typical services with their
 * usual durations and prices, and opening hours. Everything can be edited.
 */
const { registerTemplate } = require('../../core/lib/businessTemplates');
const Resource = require('./models/Resource');
const Service = require('./models/Service');
const Schedule = require('./models/Schedule');

const svc = (name, category, durationMin, euros) => ({ name, category, durationMin, price: euros * 100 });

const TUE_SAT_SPLIT = [
  { days: [2, 3, 4, 5], start: '09:30', end: '14:00' },
  { days: [2, 3, 4, 5], start: '16:00', end: '20:00' },
  { days: [6], start: '09:00', end: '14:00' },
];

const TEMPLATES = [
  {
    key: 'peluqueria', label: 'Peluquería', description: 'Cortes, color y peinados',
    services: [
      svc('Corte mujer', 'Cortes', 45, 22), svc('Corte hombre', 'Cortes', 30, 15), svc('Corte niño', 'Cortes', 30, 12),
      svc('Lavar y peinar', 'Peinados', 30, 18), svc('Tinte raíz', 'Color', 60, 35), svc('Mechas', 'Color', 120, 60),
      svc('Tratamiento hidratante', 'Tratamientos', 30, 20),
    ],
    rules: TUE_SAT_SPLIT,
  },
  {
    key: 'barberia', label: 'Barbería', description: 'Cortes, barba y afeitado',
    services: [
      svc('Corte', 'Cortes', 30, 15), svc('Corte y barba', 'Cortes', 45, 22), svc('Arreglo de barba', 'Barba', 20, 10),
      svc('Afeitado clásico', 'Barba', 30, 15), svc('Corte niño', 'Cortes', 25, 12),
    ],
    rules: [
      { days: [2, 3, 4, 5], start: '10:00', end: '14:00' },
      { days: [2, 3, 4, 5], start: '16:00', end: '20:30' },
      { days: [6], start: '09:30', end: '14:30' },
    ],
  },
  {
    key: 'estetica', label: 'Centro de estética', description: 'Faciales, manos, pies y depilación',
    services: [
      svc('Limpieza facial', 'Facial', 60, 45), svc('Manicura', 'Manos y pies', 45, 20), svc('Manicura semipermanente', 'Manos y pies', 60, 28),
      svc('Pedicura', 'Manos y pies', 60, 30), svc('Depilación piernas', 'Depilación', 45, 25), svc('Masaje relajante', 'Masajes', 60, 50),
    ],
    rules: TUE_SAT_SPLIT,
  },
  {
    key: 'citas_vacio', label: 'Otro negocio con citas', description: 'Solo el horario y una persona; los servicios los añade el negocio',
    services: [],
    rules: [
      { days: [1, 2, 3, 4, 5], start: '09:00', end: '14:00' },
      { days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00' },
    ],
  },
];

for (const t of TEMPLATES) {
  registerTemplate({
    key: t.key,
    label: t.label,
    description: t.description,
    businessType: 'appointments',
    apply: async (business, { ownerName = '' } = {}) => {
      const first = String(ownerName || '').trim().split(/\s+/)[0] || 'Yo';
      await Resource.create({ businessId: business._id, kind: 'staff', name: first.charAt(0).toUpperCase() + first.slice(1), sortOrder: 1 });
      if (!(await Schedule.exists({ businessId: business._id, ownerType: 'business' }))) {
        await Schedule.create({ businessId: business._id, ownerType: 'business', ownerId: business._id, rules: t.rules });
      }
      if (t.services.length) {
        await Service.insertMany(t.services.map((s, i) => ({
          businessId: business._id, name: s.name, category: s.category, durationMin: s.durationMin, slotIntervalMin: 15,
          requirements: [{ kind: 'staff', count: 1, customerCanChoose: true }],
          price: { amount: s.price, currency: 'eur' },
          onlineBooking: { enabled: true, minNoticeHours: 1, maxDaysAhead: 60 },
          sortOrder: i,
        })));
      }
    },
  });
}

module.exports = { TEMPLATES };
