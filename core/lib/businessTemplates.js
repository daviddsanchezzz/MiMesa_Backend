/**
 * Starting points for a new business ("Peluquería", "Restaurante"…): services,
 * opening hours, rooms… Modules and verticals register them here (core cannot
 * import them), and Vetra applies one when it creates a business for a client.
 *
 *   registerTemplate({ key, label, businessType, apply: async (business) => {} })
 */
const templates = new Map();

function registerTemplate(t) {
  if (!t?.key || typeof t.apply !== 'function') throw new Error('Invalid business template');
  templates.set(t.key, t);
}

function listTemplates() {
  return [...templates.values()].map(({ key, label, businessType, description }) => ({ key, label, businessType, description: description || '' }));
}

function getTemplate(key) {
  return templates.get(key) || null;
}

module.exports = { registerTemplate, listTemplates, getTemplate };
