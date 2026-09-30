/**
 * Bulk import of customers (from a CSV the business already has: Booksy,
 * Excel, the phone's contacts…). Rows are matched against existing customers
 * by email or phone; a match only gets the fields it was missing, nothing is
 * overwritten. Rows repeated inside the file are merged the same way.
 */
const Customer = require('../models/Customer');
const { getPhoneMatchCandidates, toStoredNormalizedPhone } = require('../lib/phoneMatching');

const MAX_ROWS = 1000; // per request; the app sends big files in batches
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class ImportError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeRow(raw) {
  const name = clean(raw?.name, 100);
  const phone = clean(raw?.phone, 30);
  let email = clean(raw?.email, 200).toLowerCase();
  const notes = String(raw?.notes ?? '').trim().slice(0, 1000);
  if (email && !EMAIL_RE.test(email)) email = '';
  if (!name && !phone && !email) return { skip: 'vacía' };
  if (!name) return { skip: 'sin nombre' };
  return { name, phone, email, notes };
}

async function importCustomers(businessId, rows) {
  if (!Array.isArray(rows) || !rows.length) throw new ImportError('No hay filas que importar');
  if (rows.length > MAX_ROWS) throw new ImportError(`Como mucho ${MAX_ROWS} filas por envío`);

  // Everything we might match against, in one query
  const existing = await Customer.find({ businessId }).select('_id name phone email notes normalizedPhone').lean();
  const byEmail = new Map();
  const byPhone = new Map();
  const byName = new Map(); // only for rows with no phone or email at all
  const nameKey = (n) => String(n || '').toLowerCase();
  const index = (c) => {
    if (c.email) byEmail.set(c.email, c);
    if (c.normalizedPhone) byPhone.set(c.normalizedPhone, c);
    if (!byName.has(nameKey(c.name))) byName.set(nameKey(c.name), c);
  };
  existing.forEach(index);
  const find = (r) => (r.email && byEmail.get(r.email))
    || getPhoneMatchCandidates(r.phone).map((p) => byPhone.get(p)).find(Boolean)
    || (!r.email && !r.phone ? byName.get(nameKey(r.name)) : null)
    || null;

  const result = { created: 0, updated: 0, unchanged: 0, skipped: [] };
  const creates = [];
  const updates = new Map(); // _id → $set

  rows.forEach((raw, i) => {
    const r = normalizeRow(raw);
    if (r.skip) { result.skipped.push({ row: i, reason: r.skip }); return; }
    const match = find(r);
    if (!match) {
      const doc = {
        businessId, name: r.name, phone: r.phone, normalizedPhone: toStoredNormalizedPhone(r.phone), email: r.email, notes: r.notes,
        _new: true,
      };
      creates.push(doc);
      index(doc);
      return;
    }
    // Fill only what's missing
    const set = {};
    if (!match.phone && r.phone) { set.phone = r.phone; set.normalizedPhone = toStoredNormalizedPhone(r.phone); }
    if (!match.email && r.email) set.email = r.email;
    if (!match.notes && r.notes) set.notes = r.notes;
    if (!Object.keys(set).length) {
      if (!match._new) result.unchanged += 1;
      return;
    }
    Object.assign(match, set);
    index(match);
    if (match._new) return; // still to be created: it carries the merged fields
    updates.set(String(match._id), { ...(updates.get(String(match._id)) || {}), ...set });
  });

  if (creates.length) {
    await Customer.insertMany(creates.map(({ _new, ...doc }) => doc), { ordered: false });
    result.created = creates.length;
  }
  if (updates.size) {
    await Customer.bulkWrite([...updates].map(([_id, set]) => ({ updateOne: { filter: { _id, businessId }, update: { $set: set } } })));
    result.updated = updates.size;
  }
  return result;
}

module.exports = { importCustomers, normalizeRow, ImportError, MAX_ROWS };
