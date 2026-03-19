/**
 * AuthUser — read-only Mongoose model pointing at Better Auth's "user" collection.
 *
 * Used to look up registered users by email when adding them to a Business.
 * Never create or update via this model — Better Auth owns this collection.
 */

const mongoose = require('mongoose');

const authUserSchema = new mongoose.Schema({
  name:          { type: String, default: '' },
  email:         { type: String, lowercase: true },
  emailVerified: { type: Boolean, default: false },
  phone:         { type: String, default: '' },
  role:          { type: String, default: 'user' },
}, {
  collection: 'user', // Better Auth's default collection name
  timestamps: true,
});

module.exports = mongoose.model('AuthUser', authUserSchema);
