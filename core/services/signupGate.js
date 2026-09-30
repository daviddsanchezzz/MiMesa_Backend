/**
 * Who may create a Vetra account. In invite-only mode (default) only Vetra
 * devs and people with a pending invitation; in open mode, anyone.
 */
const { signupMode } = require('../lib/legal');

async function canSignUp(email) {
  if (signupMode() === 'open') return true;
  const e = String(email || '').toLowerCase();
  const { isDev } = require('../middleware/requireDev');
  if (isDev(e)) return true;
  const Invitation = require('../models/Invitation');
  return !!(await Invitation.exists({ email: e, status: 'pending', expiresAt: { $gt: new Date() } }));
}

module.exports = { canSignUp };
