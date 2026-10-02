/**
 * Loaded before every test (node --require). Provides harmless placeholder
 * config so modules that build SDK clients at import time (Resend, Stripe)
 * can be loaded without real credentials. Nothing is ever sent: tests that
 * would hit an external service stub it first.
 */
process.env.NODE_ENV = 'test';
process.env.TZ = 'UTC';

const defaults = {
  RESEND_API_KEY: 're_test_placeholder',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_placeholder',
  STRIPE_PRICE_BASIC: 'price_basic_test',
  STRIPE_PRICE_PRO: 'price_pro_test',
  FRONTEND_URL: 'http://localhost:3005',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret',
  DEFAULT_TIMEZONE: 'Europe/Madrid',
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}
