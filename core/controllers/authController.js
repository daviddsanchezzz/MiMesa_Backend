const { findBusinessBySlug, changeBusinessSlug, SlugError } = require('../lib/slugs');
const { publicBookingUrl } = require('../lib/publicUrls');
const Business = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');
const { isDev } = require('../middleware/requireDev');
const { getAllModuleAccess, serializeCapabilities, getEffectivePlan } = require('../lib/planCapabilities');
const { isValidTimezone } = require('../lib/timezone');
const { checkImageDataUrl, decodeImageDataUrl, businessLogoUrl: logoUrl } = require('../lib/images');

const MAX_LOGO_CHARS = 300 * 1024;
const {
  serializeBusinessExtensions,
  applyBusinessExtensionUpdates,
  publicBusinessExtensionFields,
} = require('../lib/verticals');

const businessData = (b) => ({
  id: b._id, name: b.name, email: b.email,
  slug: b.slug || null,
  publicUrl: publicBookingUrl(b),
  phone: b.phone, address: b.address, cif: b.cif, brandColor: b.brandColor,
  logoUrl: logoUrl(b),
  timezone: b.timezone || 'Europe/Madrid',
  businessType: b.businessType || 'restaurant',
  ...serializeBusinessExtensions(b),
  // Billing / plan
  plan:               b.plan               ?? 'free',
  subscriptionStatus: b.subscriptionStatus ?? null,
  trialEndsAt:        b.trialEndsAt        ?? null,
  currentPeriodEnd:   b.currentPeriodEnd   ?? null,
  cancelAtPeriodEnd:  b.cancelAtPeriodEnd  ?? false,
  paymentFailedAt:    b.paymentFailedAt ?? null,
  // What the business can do now: basic | pro | free (only businesses from before trials) | expired (read-only)
  effectivePlan:      getEffectivePlan(b),
  legacyAccess:       !!b.legacyAccess,
  hasSubscription:    !!b.stripeSubscriptionId,
  capabilities:       serializeCapabilities(b),
  modules:            getAllModuleAccess(b),
});

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
          .populate('businessId', 'name brandColor plan subscriptionStatus legacyAccess paymentFailedAt trialEndsAt stripeSubscriptionId businessType')
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
          .populate('businessId', 'name brandColor plan subscriptionStatus legacyAccess paymentFailedAt trialEndsAt stripeSubscriptionId businessType')
          .sort({ createdAt: 1 })
          .lean();
      }
    }

    const memberships = membershipDocs.map(m => ({
      businessId:   m.businessId?._id?.toString() ?? '',
      businessName: m.businessId?.name ?? '',
      brandColor:   m.businessId?.brandColor ?? '#4f46e5',
      plan:         m.businessId?.plan ?? 'free',
      businessType: m.businessId?.businessType ?? 'restaurant',
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
    const business = await Business.findById(req.params.id).select(`name email phone address brandColor slug businessType logoUpdatedAt ${publicBusinessExtensionFields()}`.trim());
    if (!business) return res.status(404).json({ message: 'Business not found' });
    // The logo goes as a URL so the public page can show it like the appointments page.
    res.json({ ...business.toObject(), logoUrl: logoUrl(business) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/auth/public/business-by-slug/:slug  → the business behind a public address.
// An old slug answers with the current one so the page can move to it.
exports.getBusinessBySlug = async (req, res) => {
  try {
    const b = await findBusinessBySlug(Business, req.params.slug);
    if (!b) return res.status(404).json({ message: 'No encontramos este negocio', code: 'NOT_FOUND' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ id: b._id, slug: b.slug, name: b.name, businessType: b.businessType || 'restaurant', publicUrl: publicBookingUrl(b) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getBusinessLogo = async (req, res) => {
  try {
    const business = await Business.findById(req.params.id).select('+logo').lean();
    const image = decodeImageDataUrl(business?.logo);
    if (!image) return res.status(404).json({ message: 'Sin logo' });
    res.set('Content-Type', image.contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // the URL changes with each new logo
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(image.buffer);
  } catch {
    res.status(404).json({ message: 'Sin logo' });
  }
};

exports.updateBusinessSettings = async (req, res) => {
  try {
    const { brandColor, name, phone, address, email, cif } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = String(name).trim();
    if (phone !== undefined) updateData.phone = String(phone).trim();
    if (address !== undefined) updateData.address = String(address).trim();
    if (cif !== undefined) updateData.cif = String(cif).trim();
    if (brandColor !== undefined) updateData.brandColor = brandColor;
    if (req.body.logo !== undefined) {
      const logo = checkImageDataUrl(req.body.logo, { label: 'El logo', maxChars: MAX_LOGO_CHARS });
      if (logo.error) return res.status(400).json({ message: logo.error });
      updateData.logo = logo.value;
      updateData.logoUpdatedAt = logo.value ? new Date() : null;
    }
    applyBusinessExtensionUpdates(req.body, updateData);
    if (req.body.slug !== undefined) {
      try {
        await changeBusinessSlug(Business, req.businessId, req.body.slug);
      } catch (err) {
        if (err instanceof SlugError) return res.status(err.status).json({ message: err.message, code: err.code });
        throw err;
      }
    }
    if (req.body.timezone !== undefined) {
      if (!isValidTimezone(req.body.timezone)) return res.status(400).json({ message: 'Zona horaria no valida' });
      updateData.timezone = req.body.timezone;
    }
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

    await Business.updateOne({ _id: req.businessId }, updateData, { runValidators: true });
    const business = await Business.findById(req.businessId).select('-password');
    if (!business) return res.status(404).json({ message: 'Business not found' });
    res.json(businessData(business));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};
