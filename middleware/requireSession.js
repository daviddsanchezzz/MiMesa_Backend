/**
 * requireSession — lightweight auth check
 *
 * Only validates that there is a valid Better Auth session.
 * Does NOT require the user to have an associated Business.
 * Used for endpoints where the user may not yet have a business
 * (e.g. accepting an invitation right after signing up).
 *
 * Sets: req.user
 */

const { fromNodeHeaders } = require('better-auth/node');
const { getAuth } = require('../lib/auth');

module.exports = async function requireSession(req, res, next) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (session?.user) {
      req.user = session.user;
      return next();
    }
  } catch {
    // Better Auth not ready — fall through
  }

  return res.status(401).json({ message: 'No autorizado' });
};
