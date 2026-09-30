const mongoose = require('mongoose');
const { businessFieldExtensions } = require('../lib/verticals');

const businessSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  // Legacy field from the removed JWT login. No longer written or used; kept so old hashes stay excluded via select('-password').
  password:  { type: String, required: false, default: null },
  phone:     { type: String, default: '' },
  address:   { type: String, default: '' },
  cif:       { type: String, default: '' },
  // Public address: https://vetrareserve.com/{slug}. Unique, generated from the
  // name and editable. Old slugs stay in slugHistory so their links still work.
  slug:        { type: String, lowercase: true, trim: true, default: undefined },
  slugHistory: { type: [String], default: [] },
  brandColor:  { type: String, default: '#3B82F6' },
  // Logo as a small data URL. Not loaded by default: served by its own URL.
  logo:          { type: String, default: null, select: false },
  logoUpdatedAt: { type: Date, default: null },
  // What kind of business this is. Decides menus, settings and default modules:
  // 'restaurant' = table reservations (Vetra's original product),
  // 'appointments' = service appointments (salons, therapists, studios...).
  businessType: { type: String, enum: ['restaurant', 'appointments'], default: 'restaurant' },
  // Better Auth user ID that owns this business (null for legacy users)
  ownerId: { type: String, default: null, index: true },
  // IANA timezone used to interpret reservation date/time (reminders, notice windows, refunds)
  timezone: { type: String, default: 'Europe/Madrid' },

  // ── Stripe / subscriptions ───────────────────────────────────────────────
  stripeCustomerId:     { type: String, default: null },
  stripeSubscriptionId: { type: String, default: null },
  // Plan: 'free' | 'basic' | 'pro'  — add more as needed
  plan:                 { type: String, default: 'free' },
  // Mirrors Stripe subscription status: active | trialing | past_due | canceled | incomplete | null
  subscriptionStatus:   { type: String, default: null },
  trialEndsAt:          { type: Date,    default: null },
  // Created before the appointment plan limits: keeps team, reminders and
  // follow-ups whatever the plan (see planCapabilities.LEGACY_APPOINTMENT_ACCESS).
  legacyAccess:         { type: Boolean, default: false },
  currentPeriodStart:   { type: Date,    default: null },
  currentPeriodEnd:     { type: Date,    default: null },
  cancelAtPeriodEnd:    { type: Boolean, default: false },
  // Timestamp (Stripe event.created) of the last billing event applied; guards against out-of-order webhooks
  stripeEventAt:        { type: Date,    default: null },

  // ── Stripe Connect (pagos de clientes al restaurante) ────────────────────
  stripeConnectId:      { type: String, default: null },
  stripeConnectEnabled: { type: Boolean, default: false },

  // Module-level tenant overrides, e.g.:
  // moduleOverrides.staff.enabled = false
  moduleOverrides: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, { timestamps: true });

// Sector-specific fields (e.g. restaurant reservation settings) are declared by
// each enabled vertical in verticals/<name>/business.js.
for (const fields of businessFieldExtensions()) businessSchema.add(fields);

businessSchema.index({ slug: 1 }, { unique: true, sparse: true });
businessSchema.index({ slugHistory: 1 });

// Every new business gets a free slug from its name.
businessSchema.pre('save', async function assignSlug() {
  if (this.slug || !this.name) return;
  const { uniqueSlugFor } = require('../lib/slugs');
  this.slug = await uniqueSlugFor(this.constructor, this.name, this._id);
});

module.exports = mongoose.model('Business', businessSchema);
