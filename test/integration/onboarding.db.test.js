/**
 * Client onboarding by invitation: Vetra creates the business with a template
 * and invites the owner; the owner accepts (password + legal) and lands in
 * their business. Invite-only mode blocks creating businesses without an
 * invitation. Skipped unless MONGO_TEST_URI is set.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

describe('client onboarding by invitation', { skip }, () => {
  let app, mongoose, Business, BusinessMember, LegalAcceptance;
  const as = (user) => ({ 'x-test-user': user });
  const sent = [];

  before(async () => {
    process.env.DEV_EMAILS = 'david@vetra.test';
    delete process.env.SIGNUP_MODE;
    installFakeAuth();
    const delivery = require.resolve(path.join(ROOT, 'core/services/emailDelivery'));
    require(delivery);
    require.cache[delivery].exports.sendTrackedEmail = async ({ payload, source }) => {
      sent.push({ source, to: [].concat(payload.to), subject: payload.subject, html: payload.html });
      return { data: { id: 'test' } };
    };
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_onboarding_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    Business = require(path.join(ROOT, 'core/models/Business'));
    BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    LegalAcceptance = require(path.join(ROOT, 'core/models/LegalAcceptance'));
    addUser({ id: 'dev', email: 'david@vetra.test', name: 'David' });
    addUser({ id: 'stranger', email: 'someone@example.test', name: 'Someone' });
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('sign-up gate: invite-only lets in devs and invited emails only', async () => {
    const { canSignUp } = require(path.join(ROOT, 'core/services/signupGate'));
    const Invitation = require(path.join(ROOT, 'core/models/Invitation'));
    assert.equal(await canSignUp('random@example.test'), false);
    assert.equal(await canSignUp('DAVID@vetra.test'), true);
    await Invitation.create({ email: 'invited@example.test', name: 'I', role: 'staff', type: 'business' });
    assert.equal(await canSignUp('Invited@example.test'), true);
    await Invitation.create({ email: 'old@example.test', name: 'O', role: 'staff', type: 'business', expiresAt: new Date(Date.now() - 1000) });
    assert.equal(await canSignUp('old@example.test'), false, 'expired invitation');
    process.env.SIGNUP_MODE = 'open';
    try { assert.equal(await canSignUp('random@example.test'), true); } finally { delete process.env.SIGNUP_MODE; }
  });

  test('signup config is invite-only by default', async () => {
    const res = await request(app).get('/api/auth/public/signup');
    assert.equal(res.body.mode, 'invite');
    assert.ok(res.body.legalVersion);
  });

  test('Vetra creates a salon from a template and invites the owner; the owner accepts and owns it', async () => {
    let res = await request(app).get('/api/dev/templates').set(as('dev'));
    assert.ok(res.body.some((t) => t.key === 'peluqueria' && t.businessType === 'appointments'));
    assert.ok(res.body.some((t) => t.key === 'restaurante' && t.businessType === 'restaurant'));

    res = await request(app).post('/api/dev/clients').set(as('stranger')).send({});
    assert.equal(res.status, 403, 'only Vetra');

    res = await request(app).post('/api/dev/clients').set(as('dev')).send({
      business: { name: 'Peluquería Marta', businessType: 'appointments', phone: '937000111', address: 'Riera 1, Mataró', plan: 'basic', template: 'restaurante' },
      owner: { name: 'Marta Soler', email: 'marta@salon.test' },
    });
    assert.equal(res.status, 400, 'template of another type');

    sent.length = 0;
    res = await request(app).post('/api/dev/clients').set(as('dev')).send({
      business: { name: 'Peluquería Marta', businessType: 'appointments', phone: '937000111', address: 'Riera 1, Mataró', plan: 'basic', template: 'peluqueria' },
      owner: { name: 'Marta Soler', email: 'Marta@Salon.test' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const businessId = res.body.id;
    const token = new URL(res.body.inviteLink).searchParams.get('token');
    assert.ok(token);
    assert.deepEqual(sent.map((e) => [e.source, e.to[0]]), [['dev.owner_invitation', 'marta@salon.test']]);
    assert.match(sent[0].subject, /Peluquería Marta está lista/);

    // Template applied: one professional (Marta), services, opening hours
    const db = mongoose.connection.db;
    assert.equal(await db.collection('bookingresources').countDocuments({ businessId: new mongoose.Types.ObjectId(businessId) }), 1);
    assert.equal((await db.collection('bookingresources').findOne({ businessId: new mongoose.Types.ObjectId(businessId) })).name, 'Marta');
    assert.ok(await db.collection('bookingservices').countDocuments({ businessId: new mongoose.Types.ObjectId(businessId) }) >= 5);
    assert.ok(await db.collection('bookingschedules').findOne({ businessId: new mongoose.Types.ObjectId(businessId), ownerType: 'business' }));

    // Panel shows the invitation as pending
    let list = (await request(app).get('/api/dev/businesses').set(as('dev'))).body;
    let row = list.find((b) => String(b.id) === businessId);
    assert.equal(row.ownerStatus, 'invited');
    assert.equal(row.businessType, 'appointments');
    assert.ok(row.inviteLink.includes(token));

    // The invitation page says the owner must also accept the DPA
    res = await request(app).get(`/api/invitations/public/${token}`);
    assert.deepEqual(res.body.legal.documents, ['terms', 'privacy', 'dpa']);
    assert.equal(res.body.business.name, 'Peluquería Marta');

    // Marta signs up (Better Auth) — simulated by inserting the user — and accepts
    const userId = new mongoose.Types.ObjectId();
    await db.collection('user').insertOne({ _id: userId, email: 'marta@salon.test', name: 'Marta Soler', emailVerified: false });
    res = await request(app).post(`/api/invitations/accept/${token}`).send({});
    assert.equal(res.status, 400, 'legal acceptance required');
    assert.equal(res.body.code, 'LEGAL_REQUIRED');
    res = await request(app).post(`/api/invitations/accept/${token}`).set('user-agent', 'test-agent').send({ acceptLegal: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const biz = await Business.findById(businessId).lean();
    assert.equal(biz.ownerId, String(userId));
    const member = await BusinessMember.findOne({ businessId, userId: String(userId) }).lean();
    assert.equal(member.role, 'owner');
    const legal = await LegalAcceptance.findOne({ businessId }).lean();
    assert.deepEqual(legal.documents, ['terms', 'privacy', 'dpa']);
    assert.equal(legal.context, 'invitation');
    assert.equal(legal.userAgent, 'test-agent');
    assert.equal((await db.collection('user').findOne({ _id: userId })).emailVerified, true, 'the invitation proves the email');

    list = (await request(app).get('/api/dev/businesses').set(as('dev'))).body;
    row = list.find((b) => String(b.id) === businessId);
    assert.equal(row.ownerStatus, 'active');
    assert.equal(row.inviteLink, null);
    res = await request(app).post(`/api/dev/businesses/${businessId}/resend-owner-invite`).set(as('dev')).send({});
    assert.equal(res.status, 400, 'already has an owner');
    res = await request(app).post(`/api/invitations/accept/${token}`).send({ acceptLegal: true });
    assert.equal(res.status, 404, 'a used invitation cannot be reused');
  });

  test('resending the owner invitation replaces the old link', async () => {
    let res = await request(app).post('/api/dev/clients').set(as('dev')).send({
      business: { name: 'Casa Pepe', businessType: 'restaurant', template: 'restaurante' },
      owner: { name: 'Pepe', email: 'pepe@casa.test' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const first = res.body.inviteLink;
    const db = mongoose.connection.db;
    assert.equal(await db.collection('tables').countDocuments({ businessId: new mongoose.Types.ObjectId(res.body.id) }), 8);
    assert.equal(await db.collection('shifts').countDocuments({ businessId: new mongoose.Types.ObjectId(res.body.id) }), 2);
    res = await request(app).post(`/api/dev/businesses/${res.body.id}/resend-owner-invite`).set(as('dev')).send({});
    assert.equal(res.status, 200);
    assert.notEqual(res.body.inviteLink, first);
    const oldToken = new URL(first).searchParams.get('token');
    assert.equal((await request(app).get(`/api/invitations/public/${oldToken}`)).status, 404, 'old link no longer works');
  });

  test('invite-only: nobody creates a business without an invitation; open mode allows it with legal acceptance', async () => {
    let res = await request(app).post('/api/businesses').set(as('stranger')).send({ name: 'Bar X', email: 'bar@x.test', businessType: 'restaurant', acceptLegal: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'INVITE_ONLY');
    process.env.SIGNUP_MODE = 'open';
    try {
      res = await request(app).post('/api/businesses').set(as('stranger')).send({ name: 'Bar X', email: 'bar@x.test', businessType: 'restaurant' });
      assert.equal(res.status, 400, 'legal acceptance required');
      res = await request(app).post('/api/businesses').set(as('stranger')).send({ name: 'Bar X', email: 'bar@x.test', businessType: 'restaurant', acceptLegal: true });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const legal = await LegalAcceptance.findOne({ businessId: res.body.id }).lean();
      assert.equal(legal.context, 'onboarding');
      assert.deepEqual(legal.documents, ['terms', 'privacy', 'dpa']);
    } finally {
      delete process.env.SIGNUP_MODE;
    }
  });
});
