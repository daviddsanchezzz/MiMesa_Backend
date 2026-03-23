const jwt = require('jsonwebtoken');
const Business = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');
const { isDev } = require('../middleware/requireDev');

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
  phone: b.phone, cif: b.cif, brandColor: b.brandColor,
  maxReservationPeople: b.maxReservationPeople,
  maxPeoplePerSlot: b.maxPeoplePerSlot ?? null,
  reservationDuration: b.reservationDuration ?? null,
  // Billing / plan
  plan:               b.plan               ?? 'free',
  subscriptionStatus: b.subscriptionStatus ?? null,
  trialEndsAt:        b.trialEndsAt        ?? null,
  currentPeriodEnd:   b.currentPeriodEnd   ?? null,
  cancelAtPeriodEnd:  b.cancelAtPeriodEnd  ?? false,
  stripeCustomerId:   b.stripeCustomerId   ?? null,
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
    const devUser = isDev(req.user?.email) || !!req.isDev;

    // Self-resolve business context if not set (e.g. when called via requireSession)
    if (!req.businessId && req.user) {
      const requestedId = req.headers['x-business-id'];
      const activeFilter = { status: { $ne: 'invited' } };
      let m;
      if (requestedId) {
        m = await BusinessMember.findOne({ userId: req.user.id, businessId: requestedId, ...activeFilter });
        if (!m) m = await BusinessMember.findOne({ userId: req.user.id, ...activeFilter }).sort({ createdAt: 1 });
      } else {
        m = await BusinessMember.findOne({ userId: req.user.id, ...activeFilter }).sort({ createdAt: 1 });
      }
      if (m) { req.businessId = m.businessId.toString(); req.memberRole = m.role; }
    }

    // All active memberships for multi-business support
    let membershipDocs = req.user
      ? await BusinessMember.find({ userId: req.user.id, status: { $ne: 'invited' } })
          .populate('businessId', 'name brandColor plan subscriptionStatus')
          .sort({ createdAt: 1 })
          .lean()
      : [];

    // Auto-heal old invitation bug: membership created with wrong userId but same email.
    if (req.user && membershipDocs.length === 0 && req.user.email) {
      const email = req.user.email.toLowerCase();
      const legacy = await BusinessMember.find({ userEmail: email, status: { $ne: 'invited' } }).select('_id userId');
      if (legacy.length > 0) {
        await BusinessMember.updateMany(
          { _id: { $in: legacy.map((m) => m._id) } },
          { $set: { userId: req.user.id } }
        );
        membershipDocs = await BusinessMember.find({ userId: req.user.id, status: { $ne: 'invited' } })
          .populate('businessId', 'name brandColor plan subscriptionStatus')
          .sort({ createdAt: 1 })
          .lean();
      }
    }

    const memberships = membershipDocs.map(m => ({
      businessId:   m.businessId?._id?.toString() ?? '',
      businessName: m.businessId?.name ?? '',
      brandColor:   m.businessId?.brandColor ?? '#4f46e5',
      plan:         m.businessId?.plan ?? 'free',
      role:         m.role,
    }));

    if (!req.businessId) {
      return res.json({
        isDev: devUser,
        memberships,
        userId: req.user?.id ?? null,
        userName: req.user?.name ?? null,
        userEmail: req.user?.email ?? null,
      });
    }

    const business = await Business.findById(req.businessId).select('-password');
    if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });

    res.json({
      ...businessData(business),
      role:        req.memberRole ?? 'owner',
      isDev:       devUser,
      memberships,
      userId:      req.user?.id ?? null,
      userName:    req.user?.name ?? null,
      userEmail:   req.user?.email ?? null,
    });
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
    const { brandColor, maxReservationPeople, maxPeoplePerSlot, name, phone, email, cif } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = String(name).trim();
    if (phone !== undefined) updateData.phone = String(phone).trim();
    if (cif !== undefined) updateData.cif = String(cif).trim();
    if (brandColor !== undefined) updateData.brandColor = brandColor;
    if (maxReservationPeople !== undefined) updateData.maxReservationPeople = maxReservationPeople;
    if (maxPeoplePerSlot !== undefined) updateData.maxPeoplePerSlot = maxPeoplePerSlot;
    if (req.body.reservationDuration !== undefined) updateData.reservationDuration = req.body.reservationDuration;
    if (email !== undefined) {
      const normalizedEmail = String(email).trim().toLowerCase();
      const exists = await Business.findOne({
        _id: { $ne: req.businessId },
        email: normalizedEmail,
      }).select('_id');
      if (exists) {
        return res.status(400).json({ message: 'El email ya esta en uso por otro negocio' });
      }
      updateData.email = normalizedEmail;
    }

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
