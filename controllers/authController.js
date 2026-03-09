const jwt = require('jsonwebtoken');
const Business = require('../models/Business');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

exports.register = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    const exists = await Business.findOne({ email });
    if (exists) return res.status(400).json({ message: 'Email already registered' });

    const business = await Business.create({ name, email, password, phone });
    res.status(201).json({ token: signToken(business._id), business: { id: business._id, name: business.name, email: business.email, phone: business.phone, brandColor: business.brandColor, maxReservationPeople: business.maxReservationPeople } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const business = await Business.findOne({ email });
    if (!business || !(await business.matchPassword(password)))
      return res.status(401).json({ message: 'Invalid credentials' });

    res.json({ token: signToken(business._id), business: { id: business._id, name: business.name, email: business.email, phone: business.phone, brandColor: business.brandColor, maxReservationPeople: business.maxReservationPeople } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.me = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select('-password');
    res.json({ id: business._id, name: business.name, email: business.email, phone: business.phone, brandColor: business.brandColor, maxReservationPeople: business.maxReservationPeople });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPublicBusiness = async (req, res) => {
  try {
    const business = await Business.findById(req.params.id).select('name phone brandColor maxReservationPeople');
    if (!business) return res.status(404).json({ message: 'Business not found' });
    res.json(business);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateBusinessSettings = async (req, res) => {
  try {
    const { brandColor, maxReservationPeople } = req.body;
    const updateData = {};
    if (brandColor !== undefined) updateData.brandColor = brandColor;
    if (maxReservationPeople !== undefined) updateData.maxReservationPeople = maxReservationPeople;
    
    const business = await Business.findByIdAndUpdate(
      req.businessId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');
    if (!business) return res.status(404).json({ message: 'Business not found' });
    res.json({ id: business._id, name: business.name, email: business.email, phone: business.phone, brandColor: business.brandColor, maxReservationPeople: business.maxReservationPeople });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};
