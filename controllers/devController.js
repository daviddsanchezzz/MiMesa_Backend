const Business       = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');
const Reservation    = require('../models/Reservation');
const AuthUser       = require('../models/AuthUser');
const { getModuleAccess } = require('../lib/planCapabilities');
const { sendTrackedEmail } = require('../services/emailDelivery');
const { fromNodeHeaders } = require('better-auth/node');
const mongoose = require('mongoose');
const { getAuth } = require('../lib/auth');
const { isDev } = require('../middleware/requireDev');

const MODULE_CATALOG = [
  { key: 'staff', name: 'Personal', description: 'Gestion de empleados y planificacion de turnos' },
  { key: 'expenses', name: 'Finanzas', description: 'Control de gastos, categorias, proveedores y analitica financiera' },
  { key: 'thefork', name: 'TheFork', description: 'Marcado de reservas procedentes de TheFork y analitica de canal' },
];

// ── GET /api/dev/businesses ───────────────────────────────────────────────
exports.listBusinesses = async (req, res) => {
  try {
    const businesses    = await Business.find().sort({ createdAt: -1 }).lean();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const enriched = await Promise.all(businesses.map(async (b) => {
      const [memberCount, reservationsLast30d, totalReservations] = await Promise.all([
        BusinessMember.countDocuments({ businessId: b._id }),
        Reservation.countDocuments({ businessId: b._id, createdAt: { $gt: thirtyDaysAgo } }),
        Reservation.countDocuments({ businessId: b._id }),
      ]);
      return {
        id:                 b._id,
        name:               b.name,
        email:              b.email,
        phone:              b.phone || '',
        address:            b.address || '',
        plan:               b.plan || 'free',
        subscriptionStatus: b.subscriptionStatus || null,
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

// ── POST /api/dev/businesses ──────────────────────────────────────────────
exports.createBusiness = async (req, res) => {
  try {
    const { name, email, phone = '', address = '', plan = 'free' } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Nombre y email son obligatorios' });

    const VALID_PLANS = ['free', 'basic', 'pro'];
    if (!VALID_PLANS.includes(plan)) return res.status(400).json({ message: 'Plan inválido' });

    const exists = await Business.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ message: 'Ya existe un negocio con ese email' });

    const business = await Business.create({
      name,
      email: email.toLowerCase(),
      phone,
      address,
      plan,
      subscriptionStatus: plan === 'free' ? null : 'active',
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
    const VALID_PLANS = ['free', 'basic', 'pro'];
    if (!VALID_PLANS.includes(plan)) return res.status(400).json({ message: 'Plan inválido' });

    const business = await Business.findByIdAndUpdate(
      req.params.id,
      { plan, subscriptionStatus: plan === 'free' ? null : 'active' },
      { new: true },
    );
    if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

    res.json({ id: business._id, plan: business.plan, subscriptionStatus: business.subscriptionStatus });
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
    const business = await Business.findByIdAndDelete(req.params.id);
    if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

    await BusinessMember.deleteMany({ businessId: req.params.id });

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
      from:    process.env.RESEND_FROM_INVITE || 'Tableo <onboarding@resend.dev>',
      to:      email,
      subject: 'Te han dado acceso a Tableo',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px 24px;background:#fff">
          <div style="margin-bottom:24px">
            <span style="background:#4f46e5;color:#fff;font-size:12px;font-weight:600;padding:4px 10px;border-radius:9999px">Tableo</span>
          </div>
          <h2 style="font-size:22px;font-weight:700;color:#111;margin:0 0 8px">Hola, ${name} 👋</h2>
          <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 24px">
            Te han dado acceso a <strong>Tableo</strong>, la plataforma de gestión de reservas para restaurantes.
          </p>
          <a href="${inviteUrl}"
             style="display:inline-block;background:#4f46e5;color:#fff;font-size:15px;font-weight:600;padding:12px 28px;border-radius:12px;text-decoration:none">
            Activar mi cuenta
          </a>
          <p style="color:#aaa;font-size:12px;margin-top:32px">El enlace caduca en 7 días.</p>
        </div>
      `,
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
