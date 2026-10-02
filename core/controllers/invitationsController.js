const { validateLinks, applyLinks } = require('../lib/memberLinks');
const { buildInvitationEmail } = require('../services/accountEmails');
const Invitation     = require('../models/Invitation');
const { escapeHtml } = require('../lib/escapeHtml');
const BusinessMember = require('../models/BusinessMember');
const Business       = require('../models/Business');
const { Resend }     = require('resend');
const { sendTrackedEmail } = require('../services/emailDelivery');

let _warnedMissingResendKey = false;
function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    if (!_warnedMissingResendKey) {
      console.warn('[invitations] RESEND_API_KEY is not configured. Invitation emails are disabled.');
      _warnedMissingResendKey = true;
    }
    return null;
  }
  return new Resend(process.env.RESEND_API_KEY);
}

function resolveFrontendBaseUrl(req) {
  const candidates = [
    process.env.FRONTEND_URL,
    ...(process.env.FRONTEND_URLS || '').split(',').map((v) => v.trim()).filter(Boolean),
    req.headers.origin,
  ].filter(Boolean);

  const base = candidates[0] || 'http://localhost:3005';
  return base.replace(/\/+$/, '');
}

function resolveInviteFrom() {
  return (
    process.env.RESEND_FROM_INVITE ||
    process.env.RESEND_FROM_SYSTEM ||
    process.env.RESEND_FROM ||
    'Vetra <onboarding@resend.dev>'
  );
}

async function sendEmailOrThrow(payload) {
  const resend = getResendClient();
  if (!resend) {
    throw new Error('RESEND_API_KEY no configurada en el servidor');
  }
  const result = await sendTrackedEmail({
    resend,
    payload,
    source: 'invitation.send',
    metadata: { to: payload?.to },
  });
  if (result?.error) {
    throw new Error(result.error.message || 'Error enviando email con Resend');
  }
  return result;
}

// -- POST /api/invitations ---------------------------------------------------
exports.createInvitation = async (req, res) => {
  try {
    const { name, email, role = 'staff', businessId: bodyBusinessId, professionalId = null } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Nombre y email son obligatorios' });

    // By default, invitations sent from a business context are business invitations.
    // Platform invitation is only when there is no business context at all.
    const resolvedBusinessId = bodyBusinessId || req.businessId || null;
    const isPlatform = !resolvedBusinessId;
    const type = isPlatform ? 'platform' : 'business';

    if (!isPlatform) {
      const VALID_ROLES = ['owner', 'manager', 'staff'];
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ message: 'Rol invalido. Usa: owner, manager, staff' });
      }
      if (role === 'owner' && req.memberRole !== 'owner') {
        return res.status(403).json({ message: 'Solo un owner puede invitar con rol owner' });
      }
      if (professionalId) {
        const StaffEmployee = require('../../modules/staff/models/StaffEmployee');
        const professional = await StaffEmployee.findOne({ _id: professionalId, businessId: resolvedBusinessId }).select('_id memberId').lean();
        if (!professional) return res.status(400).json({ message: 'Profesional no válido para este negocio' });
        if (professional.memberId) return res.status(409).json({ message: 'Este profesional ya tiene acceso a Vetra' });
        const linkedMember = await BusinessMember.findOne({ businessId: resolvedBusinessId, userEmail: email.toLowerCase(), professionalId: { $ne: null } }).lean();
        if (linkedMember) return res.status(409).json({ message: 'Este usuario ya está vinculado a otro profesional' });
      }
    }

    const businessId = isPlatform ? null : resolvedBusinessId;

    let business = null;
    let links = {};
    if (!isPlatform) {
      business = await Business.findById(businessId);
      if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });
      try {
        links = await validateLinks(businessId, req.body.links, { email: String(email).toLowerCase() });
      } catch (err) {
        return res.status(err.status || 400).json({ message: err.message });
      }
    }

    // Cancel any previous pending invitation for this email+business (or platform)
    const cancelQuery = isPlatform
      ? { email: email.toLowerCase(), type: 'platform', status: 'pending' }
      : { email: email.toLowerCase(), businessId, status: 'pending' };
    await Invitation.updateMany(cancelQuery, { status: 'canceled' });
    if (professionalId) {
      await Invitation.updateMany({ businessId, professionalId, status: 'pending' }, { status: 'canceled' });
    }

    const invitation = await Invitation.create({
      name,
      email: email.toLowerCase(),
      businessId: isPlatform ? null : businessId,
      role: isPlatform ? 'owner' : role,
      type,
      invitedBy: req.user?.id,
      professionalId: professionalId || null,
      links,
    });

    const inviteBase = resolveFrontendBaseUrl(req);
    const inviteUrl = `${inviteBase}/invite?token=${invitation.token}`;

    if (isPlatform) {
      await sendEmailOrThrow({
        from:    resolveInviteFrom(),
        to:      email,
        ...buildInvitationEmail({ name, url: inviteUrl, platform: true }),
      });
    } else {
      await sendEmailOrThrow({
        from:    resolveInviteFrom(),
        to:      email,
        ...buildInvitationEmail({ name, businessName: business.name, role, url: inviteUrl }),
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
      links: invitation.links || {},
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// -- GET /api/invitations ----------------------------------------------------
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

// -- DELETE /api/invitations/:id ---------------------------------------------
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

// -- GET /api/invitations/public/:token --------------------------------------
// Public - used by the AcceptInvite page to prefill name/email/business.
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
      // Which legal documents this person must accept (owners also the DPA)
      legal: { version: require('../lib/legal').LEGAL_VERSION, documents: require('../lib/legal').DOCUMENTS[invitation.role === 'owner' ? 'owner' : 'member'] },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// -- POST /api/invitations/accept/:token -------------------------------------
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
    if (req.body?.acceptLegal !== true) {
      return res.status(400).json({ message: 'Debes aceptar las condiciones de uso y la política de privacidad', code: 'LEGAL_REQUIRED' });
    }

    // Find the registered user that owns this email
    const authUser = await AuthUser.findOne({ email: invitation.email.toLowerCase() }).lean();
    if (!authUser) {
      return res.status(404).json({ message: 'No se encontró ninguna cuenta para este email. Regístrate primero.' });
    }

    const canonicalUserId = authUser.id || (authUser._id ? authUser._id.toString() : null);
    if (!canonicalUserId) {
      return res.status(500).json({ message: 'No se pudo resolver el identificador del usuario' });
    }

    if (invitation.type !== 'platform') {
      const member = await BusinessMember.findOneAndUpdate(
        { userId: canonicalUserId, businessId: invitation.businessId },
        {
          role: invitation.role,
          status: 'active',
          userName: authUser.name || '',
          userEmail: (authUser.email || '').toLowerCase(),
          professionalId: invitation.professionalId || null,
        },
        { upsert: true, new: true },
      );
      if (invitation.professionalId) {
        const StaffEmployee = require('../models/StaffEmployee');
        await StaffEmployee.updateOne(
          { _id: invitation.professionalId, businessId: invitation.businessId },
          { $set: { memberId: member._id } },
        );
      }
    }

    // Whatever the invitation linked them to (e.g. their professional in the agenda)
    if (invitation.type !== 'platform' && invitation.businessId && invitation.links && Object.keys(invitation.links).length) {
      await applyLinks({ businessId: invitation.businessId, userId: canonicalUserId, links: invitation.links });
    }

    // Owner invited by Vetra: the business becomes theirs
    if (invitation.type !== 'platform' && invitation.role === 'owner' && invitation.businessId) {
      await Business.updateOne({ _id: invitation.businessId, ownerId: null }, { $set: { ownerId: canonicalUserId } });
    }
    // The invitation link reached their inbox: the email is verified.
    await AuthUser.collection.updateOne({ email: invitation.email.toLowerCase() }, { $set: { emailVerified: true } });
    await require('../services/legalService').recordAcceptance(req, {
      userId: canonicalUserId, email: invitation.email, businessId: invitation.businessId || null,
      role: invitation.type === 'platform' ? 'owner' : invitation.role, context: 'invitation',
    });

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
