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

module.exports = function requireDev(req, res, next) {
  const devEmails = getDevEmails();
  if (!devEmails.length || !devEmails.includes(req.user?.email?.toLowerCase())) {
    return res.status(403).json({ message: 'Acceso restringido a desarrolladores' });
  }
  next();
};

module.exports.isDev = (email) =>
  getDevEmails().includes((email || '').toLowerCase());
