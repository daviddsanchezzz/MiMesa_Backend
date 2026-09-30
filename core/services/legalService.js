const LegalAcceptance = require('../models/LegalAcceptance');
const { LEGAL_VERSION, DOCUMENTS } = require('../lib/legal');

/** Stores an acceptance. role 'owner' also accepts the DPA. */
async function recordAcceptance(req, { userId, email, businessId = null, role = null, context }) {
  return LegalAcceptance.create({
    userId: String(userId),
    email: String(email || '').toLowerCase(),
    businessId,
    role,
    documents: role === 'owner' ? DOCUMENTS.owner : DOCUMENTS.member,
    version: LEGAL_VERSION,
    context,
    ip: String(req.ip || req.headers?.['x-forwarded-for'] || '').slice(0, 100),
    userAgent: String(req.headers?.['user-agent'] || '').slice(0, 300),
  });
}

module.exports = { recordAcceptance };
