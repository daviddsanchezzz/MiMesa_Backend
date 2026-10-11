const BusinessMember = require('../../../core/models/BusinessMember');
const StaffEmployee = require('../models/StaffEmployee');

/** The employee the signed-in user is linked to in this business (or null). */
async function resolveMyEmployee(req) {
  const member = await BusinessMember.findOne({ businessId: req.businessId, userId: req.user.id }).select('_id professionalId').lean();
  if (!member) return null;
  return (member.professionalId && await StaffEmployee.findOne({ _id: member.professionalId, businessId: req.businessId }).lean())
    || await StaffEmployee.findOne({ businessId: req.businessId, memberId: member._id }).lean();
}

const fullName = (e) => [e?.firstName, e?.lastName].filter(Boolean).join(' ');

module.exports = { resolveMyEmployee, fullName };
