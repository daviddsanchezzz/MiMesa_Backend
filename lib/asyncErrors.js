// Express 4 ignores rejected promises from async handlers, leaving the request hanging.
// Forward them to next() so the central error handler responds.
const Layer = require('express/lib/router/layer');

const original = Layer.prototype.handle_request;

Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next();
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};

module.exports = { original };
