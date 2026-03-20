const Business       = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');
const Room           = require('../models/Room');
const Table          = require('../models/Table');
const Shift          = require('../models/Shift');
const Vacation       = require('../models/Vacation');
const Reservation    = require('../models/Reservation');
const Customer       = require('../models/Customer');
const Invitation     = require('../models/Invitation');

// POST /api/businesses
// Creates a new Business and makes the authenticated user its owner.
// Uses requireSession — works for users with no membership yet.
exports.createBusiness = async (req, res) => {
  try {
    const { name, email, phone = '', cif = '' } = req.body;
    if (!name) return res.status(400).json({ message: 'El nombre del negocio es obligatorio' });
    if (!email) return res.status(400).json({ message: 'El email del restaurante es obligatorio' });

    const business = await Business.create({
      name,
      email: email.toLowerCase(),
      phone,
      cif,
      ownerId: req.user.id,
    });

    await BusinessMember.create({
      userId:    req.user.id,
      businessId: business._id,
      role:      'owner',
      status:    'active',
      userName:  req.user.name || '',
      userEmail: req.user.email,
    });

    res.status(201).json({
      id:   business._id,
      name: business.name,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/businesses/:id
// Deletes a business owned by the authenticated user and all related data.
exports.deleteBusiness = async (req, res) => {
  try {
    const businessId = req.params.id;

    const membership = await BusinessMember.findOne({
      userId: req.user.id,
      businessId,
      role: 'owner',
      status: { $ne: 'invited' },
    }).lean();
    if (!membership) {
      return res.status(403).json({ message: 'Solo el propietario puede eliminar este negocio' });
    }

    const business = await Business.findOne({ _id: businessId, ownerId: req.user.id }).lean();
    if (!business) {
      return res.status(404).json({ message: 'Negocio no encontrado' });
    }

    await Promise.all([
      Room.deleteMany({ businessId }),
      Table.deleteMany({ businessId }),
      Shift.deleteMany({ businessId }),
      Vacation.deleteMany({ businessId }),
      Reservation.deleteMany({ businessId }),
      Customer.deleteMany({ businessId }),
      Invitation.deleteMany({ businessId }),
      BusinessMember.deleteMany({ businessId }),
      Business.deleteOne({ _id: businessId }),
    ]);

    res.json({ message: 'Negocio eliminado correctamente' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
