const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const businessSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  // password is kept for legacy users (JWT auth). Better Auth users have no password here.
  password:  { type: String, required: false, default: null },
  phone:     { type: String, default: '' },
  brandColor: { type: String, default: '#3B82F6' },
  maxReservationPeople: { type: Number, default: 20, min: 1 },
  maxPeoplePerSlot: { type: Number, default: null },
  reservationDuration: { type: Number, default: null },
  // Better Auth user ID that owns this business.
  // null for legacy users (created before Better Auth migration).
  ownerId: { type: String, default: null, index: true },
}, { timestamps: true });

businessSchema.pre('save', async function (next) {
  // Only hash if password exists and was modified
  if (!this.password || !this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

businessSchema.methods.matchPassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('Business', businessSchema);
