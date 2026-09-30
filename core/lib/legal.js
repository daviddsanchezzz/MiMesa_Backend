/**
 * Legal documents businesses accept, and how people can sign up.
 *
 * LEGAL_VERSION changes whenever the texts change (the frontend shows them at
 * /legal/*). Each acceptance is stored with the version (LegalAcceptance).
 *
 * SIGNUP_MODE:
 *   'invite' (default) — only people invited by Vetra or by a business can
 *                        create an account; new businesses are created by Vetra.
 *   'open'             — anyone can register and create their business.
 */
const LEGAL_VERSION = '2026-09-30';

// Everyone accepts the terms and the privacy policy; whoever signs up a
// business (the owner) also accepts the data processing agreement (RGPD art. 28).
const DOCUMENTS = {
  member: ['terms', 'privacy'],
  owner: ['terms', 'privacy', 'dpa'],
};

function signupMode() {
  return String(process.env.SIGNUP_MODE || 'invite').toLowerCase() === 'open' ? 'open' : 'invite';
}

module.exports = { LEGAL_VERSION, DOCUMENTS, signupMode };
