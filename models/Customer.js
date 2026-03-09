const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  name:       { type: String, required: true },
  phone:      { type: String, default: '' },
  email:      { type: String, default: '', lowercase: true },
  notes:      { type: String, default: '' },
  visits:     { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Customer', customerSchema);
