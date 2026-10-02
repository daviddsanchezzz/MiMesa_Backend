/**
 * BusinessMember — source of truth for user↔business relationships.
 *
 * A user can belong to multiple businesses; each membership carries a role.
 * Roles: owner | manager | staff
 * Role hierarchy (enforced in requireRole middleware):
 *   owner (3) > manager (2) > staff (1)
 */

const mongoose = require('mongoose');

const businessMemberSchema = new mongoose.Schema({
  // Better Auth user ID (string, not ObjectId — BA uses its own ID format)
  userId:     { type: String, required: true, index: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  role:       { type: String, default: 'staff' },
  // active = full member; invited = pending acceptance (reserved for future use)
  status:     { type: String, enum: ['active', 'invited'], default: 'active' },
  // Denormalized for display (no join needed in lists)
  userName:   { type: String, default: '' },
  userEmail:  { type: String, default: '' },
  professionalId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', default: null, index: true },
  notificationPreferences: {
    newReservationEmail: { type: Boolean, default: true },
    cancelledReservationEmail: { type: Boolean, default: true },
  },
}, { timestamps: true });

// A user can only have one membership per business
businessMemberSchema.index({ userId: 1, businessId: 1 }, { unique: true });
businessMemberSchema.index(
  { businessId: 1, professionalId: 1 },
  { unique: true, partialFilterExpression: { professionalId: { $type: 'objectId' } } },
);

module.exports = mongoose.model('BusinessMember', businessMemberSchema);
