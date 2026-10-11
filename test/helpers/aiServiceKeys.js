/**
 * Test RSA keypair for the ai-service agent-context JWT (RS256). Generated
 * once and reused: real keygen, just not loaded from env in tests.
 */
const crypto = require('node:crypto');

let cached = null;

function testKeyPair() {
  if (!cached) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    cached = { privateKey, publicKey };
  }
  return cached;
}

module.exports = { testKeyPair };
