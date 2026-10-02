const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const a = load('core/services/accountEmails');

test('verify, reset and invitation emails: Vetra brand, button link, escaped names', () => {
  const v = a.buildVerifyEmail({ name: 'lucía <b>', url: 'https://app.vetrareserve.com/verify-email?token=x' });
  assert.match(v.subject, /Confirma tu email/);
  assert.match(v.html, /Hola Lucía,/);
  assert.ok(!v.html.includes('<b>'));
  assert.ok(v.html.includes('href="https://app.vetrareserve.com/verify-email?token=x"'));
  const r = a.buildResetPasswordEmail({ name: 'Pau', url: 'https://x.test/reset?t=1' });
  assert.match(r.html, /caduca en 1 hora/);
  const i = a.buildInvitationEmail({ name: 'Marc', businessName: 'Bar <Sol>', role: 'manager', url: 'https://x.test/invite?token=1' });
  assert.equal(i.subject, 'Bar <Sol> te invita a su equipo en Vetra');
  assert.ok(i.html.includes('Bar &lt;Sol&gt;') && i.html.includes('encargado'));
  assert.match(a.buildInvitationEmail({ name: 'Marc', url: 'u', platform: true }).subject, /acceso a Vetra/);
});

test('campaign: business brand, text kept as written, unsubscribe link', () => {
  const html = a.buildCampaignEmail({
    business: { name: 'Casa Pepe', brandColor: '#15803d', email: 'hola@casapepe.test' },
    customerName: 'ana', subject: 'Menú de otoño', body: 'Línea 1\n<script>x</script>', unsubUrl: 'https://x.test/u?token=9',
  });
  assert.match(html, /Hola Ana,/);
  assert.ok(html.includes('Línea 1<br>&lt;script&gt;'));
  assert.ok(html.includes('https://x.test/u?token=9'));
  assert.ok(html.includes('#15803d'));
});
