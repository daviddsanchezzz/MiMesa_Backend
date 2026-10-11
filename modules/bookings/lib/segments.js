/**
 * Groups of customers for campaigns ("clientes de láser que no vuelven desde hace 3 meses").
 * Pure: the service loads customers and bookings and passes them in.
 */
const { rhythm, isLive, attended } = require('./customers');

const DAY = 24 * 60 * 60 * 1000;
const TYPES = ['all', 'service', 'lapsed', 'new', 'frequent'];
const DEFAULTS = { lapsedDays: 90, newDays: 30, frequentVisits: 5 };

const idOf = (x) => String(x?._id ?? x);

/** What the bookings say about each customer. */
function factsByCustomer(bookings, now) {
  const facts = new Map();
  for (const b of bookings) {
    if (!b.customerId) continue;
    const key = idOf(b.customerId);
    const f = facts.get(key) || { starts: [], services: new Set(), future: false };
    if (isLive(b) && new Date(b.start) > now) f.future = true;
    if (attended(b, now)) {
      f.starts.push(new Date(b.start));
      for (const seg of b.segments || []) f.services.add(idOf(seg.serviceId));
    }
    facts.set(key, f);
  }
  return facts;
}

function matches(type, params, { customer, facts, now }) {
  const f = facts.get(idOf(customer._id)) || { starts: [], services: new Set(), future: false };
  const sorted = [...f.starts].sort((a, b) => a - b);
  switch (type) {
    case 'all': return true;
    case 'service': return f.services.has(String(params.serviceId));
    case 'lapsed': {
      if (!sorted.length || f.future) return false;
      return (now - sorted[sorted.length - 1]) / DAY >= (params.days ?? DEFAULTS.lapsedDays);
    }
    case 'new': {
      if (!sorted.length) return false;
      return (now - sorted[0]) / DAY <= (params.days ?? DEFAULTS.newDays);
    }
    case 'frequent': return sorted.length >= (params.visits ?? DEFAULTS.frequentVisits);
    default: return false;
  }
}

/**
 * @param {object} p
 * @param {string} p.type      one of TYPES
 * @param {object} p.params    { serviceId } | { days } | { visits }
 * @param {Array}  p.customers  { _id, name, email, marketingSubscribed, marketingUnsubscribed }
 * @param {Array}  p.bookings   { customerId, status, start, end, segments }
 * @returns {{ total: number, reachable: number, customerIds: string[], sample: string[] }}
 */
function computeSegment({ type, params = {}, customers = [], bookings = [], now = new Date() }) {
  if (!TYPES.includes(type)) throw new Error('Segmento desconocido');
  const facts = factsByCustomer(bookings, now);
  const inSegment = customers.filter((customer) => matches(type, params, { customer, facts, now }));
  // Only people who agreed to receive emails (and have one) can be written to
  const reachable = inSegment.filter((c) => c.marketingSubscribed && !c.marketingUnsubscribed && c.email);
  return {
    total: inSegment.length,
    reachable: reachable.length,
    customerIds: reachable.map((c) => idOf(c)),
    sample: reachable.slice(0, 5).map((c) => c.name),
  };
}

module.exports = { computeSegment, TYPES, DEFAULTS };
