const mongoose = require('mongoose');

const shiftSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  name:       { type: String, required: true },
  startTime:  { type: String, required: true },   // "12:00"
  endTime:    { type: String, required: true },   // "16:00"
  days:       { type: [Number], default: [0,1,2,3,4,5,6] }, // 0=Dom … 6=Sáb
  startDate:  { type: String, default: null },   // 'YYYY-MM-DD', null = applies always
  endDate:    { type: String, default: null },   // 'YYYY-MM-DD', null = applies always
  interval:  { type: Number, default: 30 },       // minutes between auto-generated slots
  subShifts: [{                                  // optional specific booking slots
    time:  { type: String, required: true },
    label: { type: String, default: '' },
  }],
}, { timestamps: true });

module.exports = mongoose.model('Shift', shiftSchema);
