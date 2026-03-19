const Invitation     = require('../models/Invitation');
const BusinessMember = require('../models/BusinessMember');
const Business       = require('../models/Business');
const { Resend }     = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// ── POST /api/invitations ─────────────────────────────────────────────────
exports.createInvitation = async (req, res) => {
  try {
    const { name, email, role = 'staff' } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Nombre y email son obligatorios' });

    const VALID_ROLES = ['manager', 'staff'];
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: 'Rol inválido. Usa: manager, staff' });
    }

    const business = await Business.findById(req.businessId);
    if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

    // Cancel any previous pending invitation for this email+business
    await Invitation.updateMany(
      { email: email.toLowerCase(), businessId: req.businessId, status: 'pending' },
      { status: 'canceled' },
    );

    const invitation = await Invitation.create({
      name,
      email: email.toLowerCase(),
      businessId: req.businessId,
      role,
      invitedBy: req.user?.id,
    });

    const inviteUrl = `${process.env.FRONTEND_URL}/invite?token=${invitation.token}`;

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

    res.status(201).json({
      id:     invitation._id,
      email:  invitation.email,
      name:   invitation.name,
      role:   invitation.role,
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
      business: { name: invitation.businessId?.name, brandColor: invitation.businessId?.brandColor },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/invitations/accept/:token ───────────────────────────────────
// Called after the user has logged in / signed up.
exports.acceptInvitation = async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      token:  req.params.token,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    });
    if (!invitation) return res.status(404).json({ message: 'Invitación inválida o expirada' });

    // Verify the authenticated user's email matches
    if (req.user?.email?.toLowerCase() !== invitation.email) {
      return res.status(403).json({
        message: `Esta invitación es para ${invitation.email}. Inicia sesión con esa cuenta.`,
      });
    }

    // Create (or update) membership
    await BusinessMember.findOneAndUpdate(
      { userId: req.user.id, businessId: invitation.businessId },
      { role: invitation.role, userName: req.user.name || '', userEmail: req.user.email },
      { upsert: true, new: true },
    );

    // Mark invitation as accepted
    invitation.status = 'accepted';
    await invitation.save();

    res.json({ message: 'Bienvenido al equipo', businessId: invitation.businessId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
