/**
 * Tells people about schedule things: the employee (new schedule, decisions, a colleague
 * asks them to cover a shift) or the managers (a request waits for them). Each notice goes
 * by push and by email, whichever the person can receive. Failures never break the action.
 */
const Business = require('../../../core/models/Business');
const BusinessMember = require('../../../core/models/BusinessMember');
const StaffEmployee = require('../models/StaffEmployee');
const { sendPushToUsers } = require('../../../core/services/pushNotifications');
const { fromBusiness, sendEmail } = require('../../../core/services/emailKit');
const { escapeHtml: esc } = require('../../../core/lib/escapeHtml');
const d = require('../../../core/services/emailDesign');

const emailOn = () => Boolean(process.env.RESEND_API_KEY) && process.env.RESEND_API_KEY !== 'your_resend_api_key_here';
const appUrl = () => (process.env.APP_URL || process.env.FRONTEND_URL || 'https://app.vetrareserve.com').replace(/\/+$/, '');

/** Pure. `lines` are short plain sentences; `cta` is { label, path }. */
function buildNoticeEmail({ business, title, intro = '', lines = [], cta = null }) {
  const brand = d.brandOf(business);
  const content = `${d.h1(title)}
    ${intro ? d.p(esc(intro)) : ''}
    ${lines.length ? d.card(lines.map((l) => d.p(esc(l), { margin: '0 0 6px' })).join('')) : ''}
    ${cta ? d.buttons([{ href: `${appUrl()}${cta.path}`, label: cta.label }], brand.color) : ''}`;
  return {
    subject: `${title} - ${business.name || 'Vetra'}`,
    html: d.layout({
      brand, title, preheader: intro || title, content,
      footer: { note: `Recibes este aviso porque trabajas en ${esc(business.name || '')} y usas Vetra.` },
    }),
  };
}

async function contactOf(businessId, employee) {
  const member = employee.memberId
    ? await BusinessMember.findById(employee.memberId).select('userId userEmail').lean()
    : await BusinessMember.findOne({ businessId, professionalId: employee._id }).select('userId userEmail').lean();
  return { userId: member?.userId || null, email: member?.userEmail || employee.email || '' };
}

async function deliver(business, { userIds = [], emails = [] }, { title, body, url, intro, lines, cta, source }) {
  const jobs = [];
  if (userIds.length) {
    jobs.push(sendPushToUsers(business._id, userIds, {
      title, body, icon: '/logo.svg', badge: '/logo.svg', tag: `staff-${source}`, data: { url },
    }));
  }
  const to = [...new Set(emails.filter(Boolean))];
  if (to.length && emailOn()) {
    const mail = buildNoticeEmail({ business, title, intro: intro || body, lines, cta: cta || { label: 'Abrir Vetra', path: url } });
    jobs.push(sendEmail({ from: fromBusiness(business.name), to, subject: mail.subject, html: mail.html }, `staff.${source}`, { businessId: String(business._id) }));
  }
  await Promise.allSettled(jobs);
}

/** @param {string[]} employeeIds  @param {object} notice  title, body, url, lines, cta, source */
async function notifyEmployees(businessId, employeeIds, notice) {
  try {
    if (!employeeIds?.length) return 0;
    const [business, employees] = await Promise.all([
      Business.findById(businessId).select('name email brandColor logoUpdatedAt slug').lean(),
      StaffEmployee.find({ businessId, _id: { $in: employeeIds } }).select('firstName email memberId').lean(),
    ]);
    if (!business) return 0;
    let reached = 0;
    for (const employee of employees) {
      const { userId, email } = await contactOf(businessId, employee);
      if (!userId && !email) continue;
      reached++;
      await deliver(business, { userIds: userId ? [userId] : [], emails: [email] }, notice);
    }
    return reached;
  } catch (err) {
    console.error('[staff] notifyEmployees failed:', err.message);
    return 0;
  }
}

async function notifyManagers(businessId, notice) {
  try {
    const [business, members] = await Promise.all([
      Business.findById(businessId).select('name email brandColor logoUpdatedAt slug').lean(),
      BusinessMember.find({ businessId, status: { $ne: 'invited' }, role: { $in: ['owner', 'manager'] } }).select('userId userEmail').lean(),
    ]);
    if (!business || !members.length) return;
    await deliver(business, { userIds: members.map((m) => m.userId), emails: members.map((m) => m.userEmail) }, notice);
  } catch (err) {
    console.error('[staff] notifyManagers failed:', err.message);
  }
}

module.exports = { notifyEmployees, notifyManagers, buildNoticeEmail };
