/**
 * BusinessMember — explicit user↔restaurant relationship.
 *
 * A user can belong to multiple restaurants; each membership carries a role.
 * Roles are intentionally stored as plain strings (not enum) so new roles can
 * be added without schema migrations.
 *
 * Built-in roles: owner | manager | staff
 * Role hierarchy (enforced in requireRole middleware):
 *   owner (3) > manager (2) > staff (1)
 */

const mongoose = require('mongoose');

const businessMemberSchema = new mongoose.Schema({
  // Better Auth user ID (string, not ObjectId — BA uses its own ID format)
  userId:     { type: String, required: true, index: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  role:       { type: String, default: 'staff' },
}, { timestamps: true });

// A user can only have one role per restaurant
businessMemberSchema.index({ userId: 1, businessId: 1 }, { unique: true });

module.exports = mongoose.model('BusinessMember', businessMemberSchema);
