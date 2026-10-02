/**
 * requireDev — restricts access to developer/superadmin only.
 * Must be used after requireSession (req.user must be set).
 *
 * Configured via DEV_EMAILS env var (comma-separated list).
 */

const getDevEmails = () =>
  (process.env.DEV_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

async function ensureDevIsAdmin(user) {
  try {
    if (!user?.id) return;
    if ((user.role || '').split(',').includes('admin')) return;
    const AuthUser = require('../models/AuthUser');
    await AuthUser.updateOne(
      { id: user.id },
      { $set: { role: 'admin', updatedAt: new Date() } },
    );
    user.role = 'admin';
  } catch {
    // best effort
  }
}

module.exports = function requireDev(req, res, next) {
  const devEmails = getDevEmails();
  if (!devEmails.length || !devEmails.includes(req.user?.email?.toLowerCase())) {
    return res.status(403).json({ message: 'Acceso restringido a desarrolladores' });
  }
  ensureDevIsAdmin(req.user).finally(() => next());
};

module.exports.isDev = (email) =>
  getDevEmails().includes((email || '').toLowerCase());
