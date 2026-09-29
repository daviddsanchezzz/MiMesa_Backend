const Business       = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');
const Room           = require('../../verticals/restaurant/models/Room');
const Table          = require('../../verticals/restaurant/models/Table');
const Shift          = require('../../verticals/restaurant/models/Shift');
const Vacation       = require('../../verticals/restaurant/models/Vacation');
const Reservation    = require('../../verticals/restaurant/models/Reservation');
const Customer       = require('../models/Customer');
const Invitation     = require('../models/Invitation');
const { sendNewBusinessOwnerNotification } = require('../services/systemEmails');

// POST /api/businesses
const BUSINESS_TYPES = ['restaurant', 'appointments'];

// Creates a new Business and makes the authenticated user its owner.
// Uses requireSession — works for users with no membership yet.
exports.createBusiness = async (req, res) => {
  try {
    const { name, email, phone = '', address = '', cif = '', businessType = 'restaurant' } = req.body;
    if (!name) return res.status(400).json({ message: 'El nombre del negocio es obligatorio' });
    if (!email) return res.status(400).json({ message: 'El email del negocio es obligatorio' });
    if (!BUSINESS_TYPES.includes(businessType)) return res.status(400).json({ message: 'Tipo de negocio no valido' });

    const business = await Business.create({
      name,
      email: email.toLowerCase(),
      phone,
      address,
      cif,
      businessType,
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

    await sendNewBusinessOwnerNotification({
      business,
      owner: {
        id: req.user.id,
        name: req.user.name || '',
        email: req.user.email || '',
        phone: req.user.phone || '',
      },
    });

    res.status(201).json({
      id:   business._id,
      name: business.name,
      businessType: business.businessType,
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
