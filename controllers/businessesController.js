const Business       = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');

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
