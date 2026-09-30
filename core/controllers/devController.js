const { publicBookingUrl } = require('../lib/publicUrls');
const Business       = require('../models/Business');
const { escapeHtml } = require('../lib/escapeHtml');
const BusinessMember = require('../models/BusinessMember');
const Reservation    = require('../../verticals/restaurant/models/Reservation');
const AuthUser       = require('../models/AuthUser');
const { getModuleAccess, getEffectivePlan } = require('../lib/planCapabilities');
const { sendTrackedEmail } = require('../services/emailDelivery');
const { fromNodeHeaders } = require('better-auth/node');
const mongoose = require('mongoose');
const { getAuth } = require('../lib/auth');
const { isDev } = require('../middleware/requireDev');

const MODULE_CATALOG = [
  { key: 'staff', name: 'Personal', description: 'Gestión de empleados y planificacion de turnos' },
  { key: 'expenses', name: 'Finanzas', description: 'Control de gastos, categorías, proveedores y analitica financiera' },
  { key: 'purchases', name: 'Compras', description: 'Gestion de productos por proveedor y pedidos de compra' },
  { key: 'thefork', name: 'TheFork', description: 'Marcado de reservas procedentes de TheFork y analitica de canal' },
  { key: 'bookings', name: 'Agenda de citas', description: 'Agenda generica por servicios, profesionales y recursos (piloto para otros sectores)' },
];

// ── GET /api/dev/businesses ───────────────────────────────────────────────
exports.listBusinesses = async (req, res) => {
  try {
    const businesses    = await Business.find().sort({ createdAt: -1 }).lean();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const enriched = await Promise.all(businesses.map(async (b) => {
      const Invitation = require('../models/Invitation');
      const [memberCount, reservationsLast30d, totalReservations, owner, ownerInvite] = await Promise.all([
        BusinessMember.countDocuments({ businessId: b._id }),
        Reservation.countDocuments({ businessId: b._id, createdAt: { $gt: thirtyDaysAgo } }),
        Reservation.countDocuments({ businessId: b._id }),
        BusinessMember.findOne({ businessId: b._id, role: 'owner', status: { $ne: 'invited' } }).select('userName userEmail').lean(),
        Invitation.findOne({ businessId: b._id, role: 'owner' }).sort({ createdAt: -1 }).select('name email status expiresAt token').lean(),
      ]);
      const inviteBase = String(process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3005').split(',')[0].trim().replace(/\/$/, '');
      const pending = ownerInvite && ownerInvite.status === 'pending' && new Date(ownerInvite.expiresAt) > new Date();
      return {
        businessType:       b.businessType || 'restaurant',
        ownerStatus:        owner ? 'active' : pending ? 'invited' : ownerInvite ? 'expired' : 'none',
        ownerName:          owner?.userName || ownerInvite?.name || '',
        ownerEmail:         owner?.userEmail || ownerInvite?.email || '',
        inviteLink:         pending ? `${inviteBase}/invite?token=${ownerInvite.token}` : null,
        inviteExpiresAt:    pending ? ownerInvite.expiresAt : null,
        id:                 b._id,
        name:               b.name,
        email:              b.email,
        phone:              b.phone || '',
        address:            b.address || '',
        plan:               b.plan || 'free',
        subscriptionStatus: b.subscriptionStatus || null,
        effectivePlan:      getEffectivePlan(b),
        trialEndsAt:        b.trialEndsAt || null,
        legacyAccess:       !!b.legacyAccess,
        modules: MODULE_CATALOG.reduce((acc, m) => {
          acc[m.key] = getModuleAccess(b, m.key);
          return acc;
        }, {}),
        createdAt:          b.createdAt,
        memberCount,
        reservationsLast30d,
        totalReservations,
      };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getModuleCatalog = async (req, res) => {
  res.json(MODULE_CATALOG);
};

// —— GET /api/dev/users ————————————————————————————————————————————————————————————————
exports.listUsers = async (req, res) => {
  try {
    const [users, memberships, businesses] = await Promise.all([
      AuthUser.find().sort({ createdAt: -1 }).lean(),
      BusinessMember.find().lean(),
      Business.find().select('_id name').lean(),
    ]);

    const businessNameById = new Map(
      businesses.map((b) => [String(b._id), b.name]),
    );

    const membershipsByUserId = memberships.reduce((acc, m) => {
      if (!acc[m.userId]) acc[m.userId] = [];
      acc[m.userId].push(m);
      return acc;
    }, {});

    const enriched = users.map((u) => {
      const userKeys = [];
      if (u.id) userKeys.push(String(u.id));
      if (u._id) userKeys.push(String(u._id));

      const userMemberships = userKeys.flatMap((k) => membershipsByUserId[k] || []);
      const uniqueMemberships = userMemberships.filter(
        (m, index, arr) => arr.findIndex((x) => String(x._id) === String(m._id)) === index,
      );

      const businessItems = uniqueMemberships.map((m) => ({
        businessId: m.businessId,
        businessName: businessNameById.get(String(m.businessId)) || 'Negocio',
        role: m.role || 'staff',
        status: m.status || 'active',
      }));

      return {
        id: u.id || String(u._id),
        name: u.name || '',
        email: u.email || '',
        emailVerified: Boolean(u.emailVerified),
        role: u.role || 'user',
        createdAt: u.createdAt,
        businessCount: businessItems.length,
        businesses: businessItems,
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// -- POST /api/dev/users/:id/impersonate -------------------------------------
exports.impersonateUser = async (req, res) => {
  try {
    const targetId = String(req.params.id || '');
    const actorId = String(req.user?.id || '');

    if (!targetId) return res.status(400).json({ message: 'Usuario invalido' });
    if (!actorId) return res.status(401).json({ message: 'No autorizado' });
    if (targetId === actorId) return res.status(400).json({ message: 'No puedes impersonarte a ti mismo' });

    const targetUser = await AuthUser.findOne({ id: targetId }).lean();
    if (!targetUser) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (isDev(targetUser.email)) return res.status(400).json({ message: 'No se puede impersonar a otro usuario dev' });

    const auth = getAuth();
    const response = await auth.api.impersonateUser({
      body: { userId: targetId },
      headers: fromNodeHeaders(req.headers),
      asResponse: true,
    });

    if (!response?.ok) {
      let msg = 'No se pudo impersonar al usuario';
      try {
        const payload = await response.json();
        msg = payload?.message || msg;
      } catch {
        // ignore
      }
      return res.status(response?.status || 400).json({ message: msg });
    }

    const token = response.headers.get('set-auth-token');
    if (!token) {
      return res.status(500).json({ message: 'No se recibio token de sesion para impersonacion' });
    }

    return res.json({
      token,
      user: {
        id: targetUser.id,
        name: targetUser.name || '',
        email: targetUser.email || '',
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || 'Error interno' });
  }
};

// -- DELETE /api/dev/users/:id ----------------------------------------------
exports.deleteUser = async (req, res) => {
  try {
    const targetId = String(req.params.id || '');
    const actorId = String(req.user?.id || '');

    if (!targetId) return res.status(400).json({ message: 'Usuario invalido' });
    if (targetId === actorId) return res.status(400).json({ message: 'No puedes eliminar tu propio usuario' });

    const targetUser = await AuthUser.findOne({ id: targetId }).lean();
    if (!targetUser) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (isDev(targetUser.email)) return res.status(400).json({ message: 'No se puede eliminar un usuario dev' });

    const ownsBusinesses = await Business.exists({ ownerId: targetId });
    if (ownsBusinesses) {
      return res.status(409).json({ message: 'No puedes eliminar un usuario que todavia es owner de un negocio' });
    }

    await Promise.all([
      BusinessMember.deleteMany({ userId: targetId }),
      mongoose.connection.db.collection('session').deleteMany({ userId: targetId }),
      mongoose.connection.db.collection('account').deleteMany({ userId: targetId }),
      mongoose.connection.db.collection('user').deleteOne({ id: targetId }),
    ]);

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message || 'Error interno' });
  }
};

// Plans Vetra can set from the dev panel:
//   trial → 14 days of Pro, then read-only unless they pay (the normal start)
//   basic / pro → given by Vetra, no Stripe (active)
//   free → free access by courtesy, as businesses had before trials (legacyAccess)
const DEV_PLANS = ['trial', 'basic', 'pro', 'free'];
function devPlanFields(plan) {
  if (plan === 'trial') return { ...require('./businessesController').trialFields(), legacyAccess: false };
  if (plan === 'free') return { plan: 'free', subscriptionStatus: null, trialEndsAt: null, legacyAccess: true };
  return { plan, subscriptionStatus: 'active' };
}

// ── POST /api/dev/businesses ──────────────────────────────────────────────
exports.createBusiness = async (req, res) => {
  try {
    const { name, email, phone = '', address = '', plan = 'trial' } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Nombre y email son obligatorios' });
    if (!DEV_PLANS.includes(plan)) return res.status(400).json({ message: 'Plan inválido' });

    const exists = await Business.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ message: 'Ya existe un negocio con ese email' });

    const business = await Business.create({
      name,
      email: email.toLowerCase(),
      phone,
      address,
      ...devPlanFields(plan),
    });

    res.status(201).json({
      id: business._id, name: business.name, email: business.email, plan: business.plan,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PATCH /api/dev/businesses/:id/plan ───────────────────────────────────
exports.updatePlan = async (req, res) => {
  try {
    const { plan } = req.body;
    if (!DEV_PLANS.includes(plan)) return res.status(400).json({ message: 'Plan inválido' });

    const business = await Business.findByIdAndUpdate(req.params.id, devPlanFields(plan), { new: true });
    if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

    res.json({ id: business._id, plan: business.plan, subscriptionStatus: business.subscriptionStatus, trialEndsAt: business.trialEndsAt, legacyAccess: business.legacyAccess });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateBusinessModule = async (req, res) => {
  try {
    const { moduleKey } = req.params;
    const { enabled } = req.body;

    if (!MODULE_CATALOG.some((m) => m.key === moduleKey)) {
      return res.status(400).json({ message: 'Modulo invalido' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ message: 'enabled debe ser booleano' });
    }

    const setPath = `moduleOverrides.${moduleKey}`;
    const business = await Business.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          [setPath]: {
            enabled,
            updatedAt: new Date(),
            updatedBy: req.user?.id || null,
          },
        },
      },
      { new: true },
    );

    if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

    res.json({
      id: business._id,
      module: getModuleAccess(business, moduleKey),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /api/dev/businesses/:id ───────────────────────────────────────
exports.deleteBusiness = async (req, res) => {
  try {
    const business = await Business.findById(req.params.id).select('_id').lean();
    if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

    // Everything goes: customers, team, agenda or restaurant data (RGPD)
    await require('../services/purgeBusiness').purgeBusiness(business._id);

    res.json({ message: 'Negocio eliminado' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/dev/invite-user ────────────────────────────────────────────
// Sends a platform invitation to a new user.
exports.inviteUser = async (req, res) => {
  try {
    const Invitation = require('../models/Invitation');
    const { Resend }  = require('resend');
    const resend      = new Resend(process.env.RESEND_API_KEY);

    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Nombre y email son obligatorios' });

    // Cancel previous pending platform invitations for this email
    await Invitation.updateMany(
      { email: email.toLowerCase(), type: 'platform', status: 'pending' },
      { status: 'canceled' },
    );

    const invitation = await Invitation.create({
      name,
      email: email.toLowerCase(),
      businessId: null,
      role:       'owner',
      type:       'platform',
      invitedBy:  req.user?.id,
    });

    const inviteUrl = `${process.env.FRONTEND_URL}/invite?token=${invitation.token}`;

    await sendTrackedEmail({
      resend,
      source: 'dev.invite_user',
      metadata: { invitedEmail: email, invitationId: String(invitation._id) },
      payload: {
      from:    process.env.RESEND_FROM_INVITE || 'Vetra <onboarding@resend.dev>',
      to:      email,
      ...require('../services/accountEmails').buildInvitationEmail({ name, url: inviteUrl, platform: true }),
      },
    });

    res.status(201).json({
      id:         invitation._id,
      email:      invitation.email,
      name:       invitation.name,
      inviteLink: inviteUrl,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/dev/migrate-memberships ─────────────────────────────────────
// One-time migration: ensures every Business owner has a Membership record.
exports.migrateMemberships = async (req, res) => {
  try {
    const businesses = await Business.find({ ownerId: { $ne: null } }).lean();

    let created = 0, skipped = 0;

    for (const business of businesses) {
      const existing = await BusinessMember.findOne({
        userId:     business.ownerId,
        businessId: business._id,
      });
      if (existing) { skipped++; continue; }

      let userName = '', userEmail = business.email || '';
      try {
        const authUser = await AuthUser.findOne({ id: business.ownerId });
        if (authUser) { userName = authUser.name || ''; userEmail = authUser.email || userEmail; }
      } catch { /* AuthUser lookup best-effort */ }

      await BusinessMember.create({
        userId:     business.ownerId,
        businessId: business._id,
        role:       'owner',
        status:     'active',
        userName,
        userEmail,
      });
      created++;
    }

    res.json({
      message:  `Migración completada: ${created} memberships creadas, ${skipped} ya existían`,
      created,
      skipped,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


// ── New client: create the business, apply a template and invite the owner ──
const OWNER_INVITE_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendOwnerInvitation(req, business, { name, email }) {
  const Invitation = require('../models/Invitation');
  const { Resend } = require('resend');
  const { buildOwnerWelcomeEmail } = require('../services/accountEmails');
  await Invitation.updateMany({ businessId: business._id, role: 'owner', status: 'pending' }, { status: 'canceled' });
  const invitation = await Invitation.create({
    name, email: email.toLowerCase(), businessId: business._id, role: 'owner', type: 'business',
    invitedBy: req.user?.id, expiresAt: new Date(Date.now() + OWNER_INVITE_DAYS * 86400000),
  });
  const base = String(process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3005').split(',')[0].trim().replace(/\/$/, '');
  const inviteLink = `${base}/invite?token=${invitation.token}`;
  let emailed = false;
  if (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 'your_resend_api_key_here') {
    const result = await sendTrackedEmail({
      resend: new Resend(process.env.RESEND_API_KEY),
      source: 'dev.owner_invitation',
      metadata: { businessId: String(business._id), invitationId: String(invitation._id) },
      payload: {
        from: process.env.RESEND_FROM_INVITE || 'Vetra <onboarding@resend.dev>',
        to: email,
        replyTo: (process.env.DEV_EMAILS || '').split(',')[0].trim() || undefined,
        ...buildOwnerWelcomeEmail({ name, businessName: business.name, url: inviteLink, expiresDays: OWNER_INVITE_DAYS }),
      },
    }).catch((err) => ({ error: err }));
    emailed = !result?.error;
  }
  return { invitation, inviteLink, emailed };
}

exports.listTemplates = async (req, res) => {
  res.json(require('../lib/businessTemplates').listTemplates());
};

exports.createClient = async (req, res) => {
  try {
    const { getTemplate } = require('../lib/businessTemplates');
    const b = req.body?.business || {};
    const o = req.body?.owner || {};
    const name = String(b.name || '').trim();
    const ownerName = String(o.name || '').trim();
    const ownerEmail = String(o.email || '').trim().toLowerCase();
    const businessType = b.businessType === 'appointments' ? 'appointments' : 'restaurant';
    const plan = DEV_PLANS.includes(b.plan) ? b.plan : 'trial';
    if (!name) return res.status(400).json({ message: 'El nombre del negocio es obligatorio' });
    if (!ownerName || !EMAIL_RE.test(ownerEmail)) return res.status(400).json({ message: 'Indica el nombre y un email válido del dueño' });
    const template = b.template ? getTemplate(b.template) : null;
    if (b.template && !template) return res.status(400).json({ message: 'Plantilla no encontrada' });
    if (template && template.businessType !== businessType) return res.status(400).json({ message: 'Esa plantilla es para otro tipo de negocio' });

    const business = await Business.create({
      name,
      email: String(b.email || ownerEmail).trim().toLowerCase(),
      phone: String(b.phone || '').trim(),
      address: String(b.address || '').trim(),
      businessType,
      ...devPlanFields(plan),
      timezone: 'Europe/Madrid',
    });
    if (template) {
      try {
        await template.apply(business, { ownerName });
      } catch (err) {
        console.error('[dev] template failed:', err.message);
      }
    }
    const { inviteLink, emailed, invitation } = await sendOwnerInvitation(req, business, { name: ownerName, email: ownerEmail });
    res.status(201).json({
      id: business._id, name: business.name, businessType, plan, template: template?.key || null,
      inviteLink, emailed, inviteExpiresAt: invitation.expiresAt,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.resendOwnerInvitation = async (req, res) => {
  try {
    const Invitation = require('../models/Invitation');
    const business = await Business.findById(req.params.id);
    if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });
    const hasOwner = await BusinessMember.exists({ businessId: business._id, role: 'owner', status: { $ne: 'invited' } });
    if (hasOwner) return res.status(400).json({ message: 'Este negocio ya tiene dueño activo' });
    const last = await Invitation.findOne({ businessId: business._id, role: 'owner' }).sort({ createdAt: -1 }).lean();
    const name = String(req.body?.name || last?.name || '').trim();
    const email = String(req.body?.email || last?.email || '').trim().toLowerCase();
    if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ message: 'Indica el nombre y el email del dueño' });
    const { inviteLink, emailed, invitation } = await sendOwnerInvitation(req, business, { name, email });
    res.json({ inviteLink, emailed, inviteExpiresAt: invitation.expiresAt });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/dev/overview ─────────────────────────────────────────────────
// One call for the Vetra panel: every business with its team, owner/invitation
// status and activity, plus accounts that belong to no business.
exports.overview = async (req, res) => {
  try {
    const Invitation = require('../models/Invitation');
    const db = mongoose.connection.db;
    const DAY = 86400000;
    const since30 = new Date(Date.now() - 30 * DAY);
    const [businesses, members, users, invitations, sessions, resByBiz, res30ByBiz, bookByBiz, book30ByBiz] = await Promise.all([
      Business.find().sort({ createdAt: -1 }).lean(),
      BusinessMember.find().lean(),
      AuthUser.find().lean(),
      Invitation.find({ status: 'pending', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean(),
      db.collection('session').find({}, { projection: { userId: 1, updatedAt: 1 } }).toArray(),
      db.collection('reservations').aggregate([{ $group: { _id: '$businessId', n: { $sum: 1 } } }]).toArray(),
      db.collection('reservations').aggregate([{ $match: { createdAt: { $gte: since30 } } }, { $group: { _id: '$businessId', n: { $sum: 1 } } }]).toArray(),
      db.collection('bookings').aggregate([{ $group: { _id: '$businessId', n: { $sum: 1 } } }]).toArray(),
      db.collection('bookings').aggregate([{ $match: { createdAt: { $gte: since30 } } }, { $group: { _id: '$businessId', n: { $sum: 1 } } }]).toArray(),
    ]);
    const count = (rows) => Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
    const [resTotal, res30, bookTotal, book30] = [count(resByBiz), count(res30ByBiz), count(bookByBiz), count(book30ByBiz)];
    const lastSeen = {};
    for (const s of sessions) {
      const k = String(s.userId);
      if (!lastSeen[k] || new Date(s.updatedAt) > new Date(lastSeen[k])) lastSeen[k] = s.updatedAt;
    }
    const userById = new Map();
    for (const u of users) {
      if (u.id) userById.set(String(u.id), u);
      if (u._id) userById.set(String(u._id), u);
    }
    const devEmails = (process.env.DEV_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    const inviteBase = String(process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3005').split(',')[0].trim().replace(/\/$/, '');

    const out = businesses.map((b) => {
      const id = String(b._id);
      const team = members.filter((m) => String(m.businessId) === id && m.status !== 'invited').map((m) => {
        const u = userById.get(String(m.userId));
        return {
          userId: String(m.userId), name: m.userName || u?.name || '', email: m.userEmail || u?.email || '',
          role: m.role || 'staff', emailVerified: !!u?.emailVerified, lastSeenAt: lastSeen[String(m.userId)] || null, exists: !!u,
        };
      }).sort((x, y) => ({ owner: 0, manager: 1, staff: 2 }[x.role] ?? 3) - ({ owner: 0, manager: 1, staff: 2 }[y.role] ?? 3));
      const ownerInvite = invitations.find((i) => String(i.businessId) === id && i.role === 'owner');
      const owner = team.find((m) => m.role === 'owner');
      const appointments = b.businessType === 'appointments';
      const lastSeenAt = team.map((m) => m.lastSeenAt).filter(Boolean).sort().pop() || null;
      return {
        id,
        name: b.name,
        email: b.email || '',
        phone: b.phone || '',
        address: b.address || '',
        businessType: b.businessType || 'restaurant',
        slug: b.slug || null,
        publicUrl: publicBookingUrl(b),
        plan: b.plan || 'free',
        effectivePlan: getEffectivePlan(b),
        trialEndsAt: b.trialEndsAt || null,
        legacyAccess: !!b.legacyAccess,
        subscriptionStatus: b.subscriptionStatus || null,
        createdAt: b.createdAt,
        modules: MODULE_CATALOG.reduce((acc, m) => { acc[m.key] = getModuleAccess(b, m.key); return acc; }, {}),
        owner: owner
          ? { status: 'active', name: owner.name, email: owner.email }
          : ownerInvite
            ? { status: 'invited', name: ownerInvite.name, email: ownerInvite.email, inviteLink: `${inviteBase}/invite?token=${ownerInvite.token}`, expiresAt: ownerInvite.expiresAt }
            : { status: 'none' },
        team,
        pendingInvites: invitations.filter((i) => String(i.businessId) === id && i.role !== 'owner').map((i) => ({ name: i.name, email: i.email, role: i.role })),
        activity: {
          unit: appointments ? 'citas' : 'reservas',
          last30d: (appointments ? book30[id] : res30[id]) || 0,
          total: (appointments ? bookTotal[id] : resTotal[id]) || 0,
        },
        lastSeenAt,
      };
    });

    const withBusiness = new Set(members.map((m) => String(m.userId)));
    const orphans = users
      .filter((u) => !withBusiness.has(String(u.id || '')) && !withBusiness.has(String(u._id || '')))
      .map((u) => ({
        id: u.id || String(u._id), name: u.name || '', email: u.email || '', emailVerified: !!u.emailVerified,
        isDev: devEmails.includes(String(u.email || '').toLowerCase()), createdAt: u.createdAt || null,
        lastSeenAt: lastSeen[String(u.id || u._id)] || null,
      }))
      .sort((a, b) => Number(a.isDev) - Number(b.isDev));

    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    res.json({
      stats: {
        businesses: out.length,
        active: out.filter((b) => b.owner.status === 'active').length,
        pending: out.filter((b) => b.owner.status === 'invited').length,
        paid: out.filter((b) => ['basic', 'pro'].includes(b.effectivePlan) && b.subscriptionStatus === 'active').length,
        trialing: out.filter((b) => b.subscriptionStatus === 'trialing' && b.effectivePlan !== 'expired').length,
        expired: out.filter((b) => b.effectivePlan === 'expired').length,
        activity30d: out.reduce((s, b) => s + b.activity.last30d, 0),
        newThisMonth: out.filter((b) => new Date(b.createdAt) >= monthStart).length,
        activeLast7d: out.filter((b) => b.lastSeenAt && new Date(b.lastSeenAt) > new Date(Date.now() - 7 * DAY)).length,
      },
      businesses: out,
      orphans,
      modules: MODULE_CATALOG,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
