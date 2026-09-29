/**
 * Email golden tests: renders every email the backend sends with fixed fixture
 * data and compares the full payload (from, to, subject, html) with a stored
 * snapshot. Guarantees that reorganizing services/email.js changes no email.
 * Regenerate intentionally with: UPDATE_SNAPSHOT=1 npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT = path.join(__dirname, '..', '__snapshots__', 'emails.json');
const CANDIDATES = {
  delivery: ['../../services/emailDelivery', '../../core/services/emailDelivery'],
  email: ['../../services/email', '../../verticals/restaurant/services/reservationEmails'],
};

function resolveFirst(list) {
  for (const rel of list) {
    try { return require.resolve(path.join(__dirname, rel)); } catch { /* try next */ }
  }
  throw new Error(`None of ${list.join(', ')} exists`);
}

// Capture every outgoing email instead of calling Resend / writing EmailLog.
const sent = [];
const deliveryPath = resolveFirst(CANDIDATES.delivery);
require(deliveryPath);
require.cache[deliveryPath].exports.sendTrackedEmail = async ({ payload, source, metadata }) => {
  sent.push({ source, metadata, payload });
  return { data: { id: 'test' } };
};

const email = require(resolveFirst(CANDIDATES.email));

const business = {
  _id: 'biz1',
  name: 'La Brasserie <Test>',
  email: 'hola@labrasserie.test',
  phone: '+34 600 000 000',
  cif: 'B00000000',
  brandColor: '#3B82F6',
};
const reservation = {
  _id: 'res1',
  publicToken: 'tok123',
  guestName: 'Ana & Co',
  guestEmail: 'ana@example.test',
  guestPhone: '612345678',
  date: '2026-10-17',
  time: '21:00',
  people: 4,
  notes: 'Cumpleaños, trona para bebé',
  roomId: { name: 'Terraza' },
  tableId: { name: 'Mesa 7' },
  proposedAlternative: { date: '2026-10-18', time: '20:30', message: 'Mañana tenemos sitio' },
};
const staff = ['manager@labrasserie.test'];

const scenarios = {
  confirmation: () => email.sendReservationConfirmation(reservation, business),
  statusConfirmed: () => email.sendStatusUpdate(reservation, business, 'confirmed'),
  statusCancelled: () => email.sendStatusUpdate(reservation, business, 'cancelled'),
  staffNew: () => email.sendStaffReservationNotification(staff, reservation, business, 'created', { noShowCount: 2, cancellationCount: 1 }),
  staffCancelled: () => email.sendStaffReservationNotification(staff, reservation, business, 'cancelled'),
  staffPendingApproval: () => email.sendPendingApprovalStaffNotification(staff, reservation, business),
  pending: () => email.sendReservationPendingEmail(reservation, business),
  alternative: () => email.sendAlternativeProposalEmail(reservation, business),
  reminder: () => email.sendReservationReminderEmail(reservation, business),
  contact: () => email.sendContactEmail({ name: 'Pepe', email: 'pepe@example.test', subject: 'Hola', message: 'Quiero info <b>ya</b>' }),
  newBusinessOwner: () => email.sendNewBusinessOwnerNotification({ business, owner: { id: 'u1', name: 'Marc', email: 'marc@example.test' } }),
};

test('every email renders exactly as before', async () => {
  const originalLog = console.log;
  console.log = () => {};
  process.env.DEV_EMAILS = 'dev@example.test';
  process.env.APP_URL = 'https://app.example.test';
  const output = {};
  try {
    for (const [name, run] of Object.entries(scenarios)) {
      sent.length = 0;
      await run();
      output[name] = sent.map((s) => ({ ...s }));
    }
  } finally {
    console.log = originalLog;
  }

  for (const [name, emails] of Object.entries(output)) {
    assert.ok(emails.length > 0 || name === 'contact', `scenario "${name}" sent nothing`);
  }

  const serialized = JSON.stringify(output, null, 2) + '\n';
  if (process.env.UPDATE_SNAPSHOT || !fs.existsSync(SNAPSHOT)) {
    fs.writeFileSync(SNAPSHOT, serialized);
    return;
  }
  assert.equal(serialized, fs.readFileSync(SNAPSHOT, 'utf8'));
});
