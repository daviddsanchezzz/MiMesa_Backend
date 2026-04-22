const BusinessMember = require('../models/BusinessMember');
const AuthUser       = require('../models/AuthUser');

// -- GET /api/members -------------------------------------------------------
// List all members of the current business.
exports.listMembers = async (req, res) => {
  try {
    const members = await BusinessMember
      .find({ businessId: req.businessId })
      .sort({ createdAt: 1 })
      .lean();
    res.json(members);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// -- POST /api/members ------------------------------------------------------
// Add a registered user to this business by email.
// The user must already have a Better Auth account.
exports.addMember = async (req, res) => {
  try {
    const { email, role = 'staff' } = req.body;
    if (!email) return res.status(400).json({ message: 'El email es obligatorio' });

    const VALID_ADD_ROLES = ['owner', 'manager', 'staff'];
    if (!VALID_ADD_ROLES.includes(role)) {
      return res.status(400).json({ message: `Rol inválido. Usa: ${VALID_ADD_ROLES.join(', ')}` });
    }
    if (role === 'owner' && req.role !== 'owner') {
      return res.status(403).json({ message: 'Solo un owner puede asignar el rol owner' });
    }

    // Look up the Better Auth user by email
    const user = await AuthUser.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({
        message: 'No existe ninguna cuenta con ese email. El usuario debe registrarse primero.',
      });
    }

    const userId = user._id.toString();

    // Prevent adding yourself
    if (req.user && userId === req.user.id) {
      return res.status(400).json({ message: 'No puedes añadirte a ti mismo' });
    }

    // Check if already a member
    const existing = await BusinessMember.findOne({ userId, businessId: req.businessId });
    if (existing) {
      return res.status(409).json({ message: 'Este usuario ya es miembro del negocio' });
    }

    const member = await BusinessMember.create({
      userId,
      businessId: req.businessId,
      role,
      userName:  user.name  || '',
      userEmail: user.email || '',
    });

    res.status(201).json(member);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// -- PUT /api/members/:memberId ---------------------------------------------
// Change a member's role. Only owners can do this.
exports.updateRole = async (req, res) => {
  try {
    const { role } = req.body;
    const VALID_ROLES = ['owner', 'manager', 'staff'];
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: `Rol inválido. Usa: ${VALID_ROLES.join(', ')}` });
    }

    const member = await BusinessMember.findOne({
      _id:        req.params.memberId,
      businessId: req.businessId,
    });
    if (!member) return res.status(404).json({ message: 'Miembro no encontrado' });

    // Prevent modifying your own role
    if (req.user && member.userId === req.user.id) {
      return res.status(400).json({ message: 'No puedes cambiar tu propio rol' });
    }

    member.role = role;
    await member.save();
    res.json(member);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// -- DELETE /api/members/:memberId ------------------------------------------
// Remove a member from this business. Cannot remove the owner.
exports.removeMember = async (req, res) => {
  try {
    const member = await BusinessMember.findOne({
      _id:        req.params.memberId,
      businessId: req.businessId,
    });
    if (!member) return res.status(404).json({ message: 'Miembro no encontrado' });

    if (member.role === 'owner') {
      return res.status(400).json({ message: 'No se puede eliminar al propietario del negocio' });
    }
    if (req.user && member.userId === req.user.id) {
      return res.status(400).json({ message: 'No puedes eliminarte a ti mismo' });
    }

    await member.deleteOne();
    res.json({ message: 'Miembro eliminado correctamente' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// -- PUT /api/members/:memberId/notifications ------------------------------
// Authenticated users can only update their own notification preferences.
exports.updateNotifications = async (req, res) => {
  try {
    const { newReservationEmail, cancelledReservationEmail } = req.body || {};

    const member = await BusinessMember.findOne({
      _id: req.params.memberId,
      businessId: req.businessId,
    });
    if (!member) return res.status(404).json({ message: 'Miembro no encontrado' });

    if (!req.user || member.userId !== req.user.id) {
      return res.status(403).json({ message: 'No puedes modificar las notificaciones de otro usuario' });
    }

    member.notificationPreferences = {
      newReservationEmail:
        newReservationEmail !== undefined
          ? !!newReservationEmail
          : (member.notificationPreferences?.newReservationEmail ?? true),
      cancelledReservationEmail:
        cancelledReservationEmail !== undefined
          ? !!cancelledReservationEmail
          : (member.notificationPreferences?.cancelledReservationEmail ?? true),
    };

    await member.save();
    res.json({ notificationPreferences: member.notificationPreferences });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


