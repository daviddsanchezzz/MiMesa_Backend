/**
 * requireServiceToken — proves a request to /api/internal/ai/* came from
 * the real ai-service, via a shared secret header (docs/VETRA_AI_ARCHITECTURE.md §6).
 * Must run before requireAgentContext: this only checks the CALLER's
 * identity, not which business/agent it's acting for.
 *
 * Compares as SHA-256 digests (fixed length) rather than the raw strings,
 * so crypto.timingSafeEqual never sees a length mismatch to throw on, and
 * a wrong-length guess doesn't behave differently from a same-length one.
 */
const crypto = require('crypto');

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

module.exports = function requireServiceToken(req, res, next) {
  const expected = process.env.AI_SERVICE_TOKEN;
  const provided = req.headers['x-service-token'];

  if (!expected || typeof provided !== 'string' || !provided) {
    return res.status(401).json({ message: 'Token de servicio invalido' });
  }

  if (!crypto.timingSafeEqual(digest(provided), digest(expected))) {
    return res.status(401).json({ message: 'Token de servicio invalido' });
  }

  next();
};
