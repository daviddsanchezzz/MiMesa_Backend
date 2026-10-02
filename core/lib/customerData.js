/**
 * Personal data of a business's customer kept by each part of the app
 * (appointments, restaurant reservations…). Modules register how to find,
 * export and erase it; core cannot import them.
 *
 *   registerCustomerData({
 *     key: 'bookings',
 *     label: 'Citas',
 *     upcoming: async ({ businessId, customer }) => count,   // still to happen: blocks erasing
 *     exportRows: async ({ businessId, customer }) => [{…}],   // plain JSON for the customer
 *     erase: async ({ businessId, customer }) => count,        // anonymize what must be kept
 *   })
 */
const kinds = new Map();

function registerCustomerData(kind) {
  if (!kind?.key || ['upcoming', 'exportRows', 'erase'].some((f) => typeof kind[f] !== 'function')) {
    throw new Error('Invalid customer data handler');
  }
  kinds.set(kind.key, kind);
}

async function upcomingFor(businessId, customer) {
  const out = [];
  for (const k of kinds.values()) {
    const n = await k.upcoming({ businessId, customer });
    if (n) out.push({ key: k.key, label: k.label, count: n });
  }
  return out;
}

async function exportFor(businessId, customer) {
  const out = {};
  for (const k of kinds.values()) out[k.key] = await k.exportRows({ businessId, customer });
  return out;
}

async function eraseFor(businessId, customer) {
  const out = {};
  for (const k of kinds.values()) out[k.key] = await k.erase({ businessId, customer });
  return out;
}

module.exports = { registerCustomerData, upcomingFor, exportFor, eraseFor, _kinds: kinds };
