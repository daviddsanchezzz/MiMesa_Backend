const jwt = require('jsonwebtoken');
const Business = require('../models/Business');

const signAccessToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '15m' });

const signRefreshToken = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '90d' });

const setRefreshCookie = (res, token) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
  });
};

const businessData = (b) => ({
  id: b._id, name: b.name, email: b.email,
  phone: b.phone, brandColor: b.brandColor,
  maxReservationPeople: b.maxReservationPeople,
  maxPeoplePerSlot: b.maxPeoplePerSlot ?? null,
  reservationDuration: b.reservationDuration ?? null,
});

exports.register = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    const exists = await Business.findOne({ email });
    if (exists) return res.status(400).json({ message: 'Email already registered' });

    const business = await Business.create({ name, email, password, phone });
    const refreshToken = signRefreshToken(business._id);
    setRefreshCookie(res, refreshToken);
    res.status(201).json({ accessToken: signAccessToken(business._id), refreshToken, business: businessData(business) });
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

    const refreshToken = signRefreshToken(business._id);
    setRefreshCookie(res, refreshToken);
    res.json({ accessToken: signAccessToken(business._id), refreshToken, business: businessData(business) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.refresh = (req, res) => {
  // Accept token from cookie (web) or request body (mobile/Safari fallback)
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) return res.status(401).json({ message: 'No refresh token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const newRefreshToken = signRefreshToken(decoded.id);
    setRefreshCookie(res, newRefreshToken);
    res.json({ accessToken: signAccessToken(decoded.id), refreshToken: newRefreshToken });
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
    // req.memberRole is set by requireAuth for Better Auth sessions;
    // legacy JWT users are always owners.
    res.json({ ...businessData(business), role: req.memberRole ?? 'owner' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPublicBusiness = async (req, res) => {
  try {
    const business = await Business.findById(req.params.id).select('name email phone brandColor maxReservationPeople maxPeoplePerSlot reservationDuration');
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
    if (req.body.reservationDuration !== undefined) updateData.reservationDuration = req.body.reservationDuration;

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
