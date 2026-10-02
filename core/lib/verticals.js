/**
 * Loads the enabled verticals (see verticals.config.js) and exposes what each
 * one adds to the Business: extra schema fields, extra fields in the API
 * payload, accepted settings updates and fields shown on the public page.
 *
 * A vertical's extension file (verticals/<name>/business.js) may export:
 *   fields:        mongoose schema fields added to Business
 *   publicFields:  space-separated fields the public booking page can read
 *   serialize(b):  extra properties for the business payload sent to the app
 *   applyUpdate(body, update): copy accepted settings from body into update
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let cached = null;

function loadExtensions() {
  if (cached) return cached;
  const { verticals = [] } = require(path.join(ROOT, 'verticals.config.js'));
  cached = verticals.map((name) => ({ name, ...require(path.join(ROOT, 'verticals', name, 'business.js')) }));
  return cached;
}

function businessFieldExtensions() {
  return loadExtensions().map((v) => v.fields).filter(Boolean);
}

function serializeBusinessExtensions(business) {
  return Object.assign({}, ...loadExtensions().map((v) => (v.serialize ? v.serialize(business) : {})));
}

function applyBusinessExtensionUpdates(body, update) {
  for (const v of loadExtensions()) if (v.applyUpdate) v.applyUpdate(body, update);
  return update;
}

function publicBusinessExtensionFields() {
  return loadExtensions().map((v) => v.publicFields).filter(Boolean).join(' ');
}

module.exports = {
  businessFieldExtensions,
  serializeBusinessExtensions,
  applyBusinessExtensionUpdates,
  publicBusinessExtensionFields,
};
