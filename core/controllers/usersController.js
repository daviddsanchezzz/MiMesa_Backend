const { fromNodeHeaders } = require('better-auth/node');
const AuthUser = require('../models/AuthUser');
const BusinessMember = require('../models/BusinessMember');
const { getAuth } = require('../lib/auth');

const DEFAULT_NOTIFICATION_PREFERENCES = {
  newReservationEmail: false,
  cancelledReservationEmail: false,
};

const STAFF_NOTIFICATION_PREFERENCES = {
  newReservationEmail: false,
  cancelledReservationEmail: false,
};

exports.getMe = async (req, res) => {
  try {
    const user = await AuthUser.findById(req.user.id).select('name email phone').lean();
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    const memberships = await BusinessMember.find({ userId: req.user.id, status: { $ne: 'invited' } })
      .populate('businessId', 'name')
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      user: {
        id: req.user.id,
        name: user.name || '',
        email: user.email || '',
        phone: user.phone || '',
      },
      memberships: memberships.map((m) => ({
        id: m._id.toString(),
        businessId: m.businessId?._id?.toString() || '',
        businessName: m.businessId?.name || '',
        role: m.role || 'staff',
        notificationPreferences: (m.role || 'staff') === 'staff'
          ? STAFF_NOTIFICATION_PREFERENCES
          : {
              ...DEFAULT_NOTIFICATION_PREFERENCES,
              ...(m.notificationPreferences || {}),
            },
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateMe = async (req, res) => {
  try {
    const { name, phone } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'El nombre es obligatorio' });
    }

    const update = { name: name.trim() };
    if (typeof phone === 'string') update.phone = phone.trim();

    const user = await AuthUser.findByIdAndUpdate(
      req.user.id,
      update,
      { new: true, runValidators: true }
    ).select('name email phone');

    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    await BusinessMember.updateMany(
      { userId: req.user.id },
      { $set: { userName: user.name || '', userEmail: user.email || '' } }
    );

    res.json({
      user: {
        id: req.user.id,
        name: user.name || '',
        email: user.email || '',
        phone: user.phone || '',
      },
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.updatePassword = async (req, res) => {
  try {
    const newPassword = (req.body?.newPassword || '').trim();
    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'La contraseña debe tener al menos 8 caracteres' });
    }

    const auth = getAuth();
    await auth.api.setPassword({
      body: { newPassword },
      headers: fromNodeHeaders(req.headers),
    });

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    res.status(400).json({ message: err.message || 'No se pudo actualizar la contraseña' });
  }
};

exports.updateMembershipNotifications = async (req, res) => {
  try {
    const { membershipId } = req.params;
    const { newReservationEmail, cancelledReservationEmail } = req.body || {};

    const membership = await BusinessMember.findOne({
      _id: membershipId,
      userId: req.user.id,
      status: { $ne: 'invited' },
    });
    if (!membership) return res.status(404).json({ message: 'Membresia no encontrada' });

    if ((membership.role || 'staff') === 'staff') {
      membership.notificationPreferences = STAFF_NOTIFICATION_PREFERENCES;
      await membership.save();

      return res.json({
        id: membership._id.toString(),
        notificationPreferences: STAFF_NOTIFICATION_PREFERENCES,
      });
    }

    membership.notificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      ...(membership.notificationPreferences?.toObject?.() || membership.notificationPreferences || {}),
      ...(newReservationEmail !== undefined ? { newReservationEmail: !!newReservationEmail } : {}),
      ...(cancelledReservationEmail !== undefined ? { cancelledReservationEmail: !!cancelledReservationEmail } : {}),
    };

    await membership.save();

    res.json({
      id: membership._id.toString(),
      notificationPreferences: membership.notificationPreferences,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};
