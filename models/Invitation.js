const mongoose = require('mongoose');
const crypto   = require('crypto');

const invitationSchema = new mongoose.Schema({
  email:      { type: String, required: true, lowercase: true },
  name:       { type: String, required: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  role:       { type: String, default: 'staff' },
  token:      { type: String, required: true, unique: true, default: () => crypto.randomBytes(32).toString('hex') },
  status:     { type: String, enum: ['pending', 'accepted', 'canceled'], default: 'pending' },
  expiresAt:  { type: Date,   required: true, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }, // 7 days
  invitedBy:  { type: String }, // Better Auth userId
}, { timestamps: true });

module.exports = mongoose.model('Invitation', invitationSchema);
