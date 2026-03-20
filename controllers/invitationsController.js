const Invitation     = require('../models/Invitation');
const BusinessMember = require('../models/BusinessMember');
const Business       = require('../models/Business');
const { Resend }     = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// ── POST /api/invitations ─────────────────────────────────────────────────
exports.createInvitation = async (req, res) => {
  try {
    const { name, email, role = 'staff', businessId: bodyBusinessId } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Nombre y email son obligatorios' });

    // Platform invitation (from dev): no business attached
    const isPlatform = !bodyBusinessId;
    const type = isPlatform ? 'platform' : 'business';

    if (!isPlatform) {
      const VALID_ROLES = ['manager', 'staff'];
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ message: 'Rol inválido. Usa: manager, staff' });
      }
    }

    const businessId = isPlatform ? null : (bodyBusinessId || req.businessId);

    let business = null;
    if (!isPlatform) {
      business = await Business.findById(businessId);
      if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });
    }

    // Cancel any previous pending invitation for this email+business (or platform)
    const cancelQuery = isPlatform
      ? { email: email.toLowerCase(), type: 'platform', status: 'pending' }
      : { email: email.toLowerCase(), businessId, status: 'pending' };
    await Invitation.updateMany(cancelQuery, { status: 'canceled' });

    const invitation = await Invitation.create({
      name,
      email: email.toLowerCase(),
      businessId: isPlatform ? null : businessId,
      role: isPlatform ? 'owner' : role,
      type,
      invitedBy: req.user?.id,
    });

    const inviteUrl = `${process.env.FRONTEND_URL}/invite?token=${invitation.token}`;

    if (isPlatform) {
      await resend.emails.send({
        from:    process.env.RESEND_FROM_INVITE || 'Mimesa <onboarding@resend.dev>',
        to:      email,
        subject: `Te han invitado a MiMesa`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px 24px;background:#fff">
            <div style="margin-bottom:24px">
              <span style="background:#4f46e5;color:#fff;font-size:12px;font-weight:600;padding:4px 10px;border-radius:9999px">MiMesa</span>
            </div>
            <h2 style="font-size:22px;font-weight:700;color:#111;margin:0 0 8px">Hola, ${name} 👋</h2>
            <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 24px">
              Te han dado acceso a <strong>MiMesa</strong>, la plataforma de gestión de reservas para restaurantes.
              Haz clic en el botón para activar tu cuenta.
            </p>
            <a href="${inviteUrl}"
               style="display:inline-block;background:#4f46e5;color:#fff;font-size:15px;font-weight:600;padding:12px 28px;border-radius:12px;text-decoration:none">
              Activar mi cuenta
            </a>
            <p style="color:#aaa;font-size:12px;margin-top:32px">
              Si no esperabas esta invitación, ignora este email. El enlace caduca en 7 días.
            </p>
          </div>
        `,
      });
    } else {
      await resend.emails.send({
        from:    process.env.RESEND_FROM || 'Mimesa <onboarding@resend.dev>',
        to:      email,
        subject: `${business.name} te invita a unirte a MiMesa`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px 24px;background:#fff">
            <div style="margin-bottom:24px">
              <span style="background:#4f46e5;color:#fff;font-size:12px;font-weight:600;padding:4px 10px;border-radius:9999px">MiMesa</span>
            </div>
            <h2 style="font-size:22px;font-weight:700;color:#111;margin:0 0 8px">Hola, ${name} 👋</h2>
            <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 8px">
              <strong>${business.name}</strong> te ha invitado a unirte a su equipo en MiMesa
              con el rol de <strong>${role === 'manager' ? 'Manager' : 'Staff'}</strong>.
            </p>
            <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 24px">
              Haz clic en el botón para activar tu cuenta. El enlace caduca en 7 días.
            </p>
            <a href="${inviteUrl}"
               style="display:inline-block;background:#4f46e5;color:#fff;font-size:15px;font-weight:600;padding:12px 28px;border-radius:12px;text-decoration:none">
              Activar cuenta y unirme
            </a>
            <p style="color:#aaa;font-size:12px;margin-top:32px">
              Si no esperabas esta invitación, ignora este email.
            </p>
          </div>
        `,
      });
    }

    res.status(201).json({
      id:     invitation._id,
      email:  invitation.email,
      name:   invitation.name,
      role:   invitation.role,
      type:   invitation.type,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/invitations ──────────────────────────────────────────────────
exports.listInvitations = async (req, res) => {
  try {
    const invitations = await Invitation.find({
      businessId: req.businessId,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 }).lean();
    res.json(invitations);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /api/invitations/:id ───────────────────────────────────────────
exports.cancelInvitation = async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      _id:        req.params.id,
      businessId: req.businessId,
    });
    if (!invitation) return res.status(404).json({ message: 'Invitación no encontrada' });
    invitation.status = 'canceled';
    await invitation.save();
    res.json({ message: 'Invitación cancelada' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/invitations/public/:token ────────────────────────────────────
// Public — used by the AcceptInvite page to prefill name/email/business.
exports.getPublicInvitation = async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      token:  req.params.token,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }).populate('businessId', 'name brandColor').lean();

    if (!invitation) {
      return res.status(404).json({ message: 'Invitación inválida o expirada' });
    }

    res.json({
      name:     invitation.name,
      email:    invitation.email,
      role:     invitation.role,
      type:     invitation.type || 'business',
      business: invitation.businessId
        ? { name: invitation.businessId.name, brandColor: invitation.businessId.brandColor }
        : null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/invitations/accept/:token ───────────────────────────────────
// Token-authenticated: no session required. The invite token is the credential.
// The frontend calls this right after signUp/signIn; cross-origin cookies are
// unreliable at that moment, so we look up the user by email instead.
exports.acceptInvitation = async (req, res) => {
  try {
    const AuthUser = require('../models/AuthUser');

    const invitation = await Invitation.findOne({
      token:     req.params.token,
      status:    'pending',
      expiresAt: { $gt: new Date() },
    });
    if (!invitation) return res.status(404).json({ message: 'Invitación inválida o expirada' });

    // Find the registered user that owns this email
    const authUser = await AuthUser.findOne({ email: invitation.email.toLowerCase() });
    if (!authUser) {
      return res.status(404).json({ message: 'No se encontró ninguna cuenta para este email. Regístrate primero.' });
    }

    const canonicalUserId = authUser.id || authUser._doc?.id;
    if (!canonicalUserId) {
      return res.status(500).json({ message: 'No se pudo resolver el identificador del usuario' });
    }

    if (invitation.type !== 'platform') {
      await BusinessMember.findOneAndUpdate(
        { userId: canonicalUserId, businessId: invitation.businessId },
        {
          role: invitation.role,
          status: 'active',
          userName: authUser.name || '',
          userEmail: (authUser.email || '').toLowerCase(),
        },
        { upsert: true, new: true },
      );
    }

    invitation.status = 'accepted';
    await invitation.save();

    res.json({
      message:    invitation.type === 'platform' ? 'Cuenta activada' : 'Bienvenido al equipo',
      type:       invitation.type || 'business',
      businessId: invitation.businessId ?? null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
