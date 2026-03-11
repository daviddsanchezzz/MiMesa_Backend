const jwt = require('jsonwebtoken');
const Business = require('../models/Business');

const signAccessToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '15m' });

const signRefreshToken = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '60d' });

const setRefreshCookie = (res, token) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 60 * 24 * 60 * 60 * 1000, // 60 days
  });
};

const businessData = (b) => ({
  id: b._id, name: b.name, email: b.email,
  phone: b.phone, brandColor: b.brandColor,
  maxReservationPeople: b.maxReservationPeople,
  maxPeoplePerSlot: b.maxPeoplePerSlot ?? null,
});

exports.register = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    const exists = await Business.findOne({ email });
    if (exists) return res.status(400).json({ message: 'Email already registered' });

    const business = await Business.create({ name, email, password, phone });
    setRefreshCookie(res, signRefreshToken(business._id));
    res.status(201).json({ accessToken: signAccessToken(business._id), business: businessData(business) });
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

    setRefreshCookie(res, signRefreshToken(business._id));
    res.json({ accessToken: signAccessToken(business._id), business: businessData(business) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.refresh = (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) return res.status(401).json({ message: 'No refresh token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    res.json({ accessToken: signAccessToken(decoded.id) });
  } catch {
    res.status(401).json({ message: 'Invalid refresh token' });
  }
};

exports.logout = (req, res) => {
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  });
  res.json({ message: 'Logged out' });
};

exports.me = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select('-password');
    res.json(businessData(business));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPublicBusiness = async (req, res) => {
  try {
    const business = await Business.findById(req.params.id).select('name email phone brandColor maxReservationPeople maxPeoplePerSlot');
    if (!business) return res.status(404).json({ message: 'Business not found' });
    res.json(business);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateBusinessSettings = async (req, res) => {
  try {
    const { brandColor, maxReservationPeople, maxPeoplePerSlot } = req.body;
    const updateData = {};
    if (brandColor !== undefined) updateData.brandColor = brandColor;
    if (maxReservationPeople !== undefined) updateData.maxReservationPeople = maxReservationPeople;
    if (maxPeoplePerSlot !== undefined) updateData.maxPeoplePerSlot = maxPeoplePerSlot;

    const business = await Business.findByIdAndUpdate(
      req.businessId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');
    if (!business) return res.status(404).json({ message: 'Business not found' });
    res.json(businessData(business));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};
