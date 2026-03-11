const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const businessSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  password:  { type: String, required: true },
  phone:     { type: String, default: '' },
  brandColor: { type: String, default: '#3B82F6' }, // Default blue color
  maxReservationPeople: { type: Number, default: 20, min: 1 }, // Maximum people per reservation
  maxPeoplePerSlot: { type: Number, default: null }, // Max concurrent people per time slot (null = unlimited)
}, { timestamps: true });

businessSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

businessSchema.methods.matchPassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('Business', businessSchema);
