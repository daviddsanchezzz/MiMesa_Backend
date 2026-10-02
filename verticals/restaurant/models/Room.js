const mongoose = require('mongoose');

const ELEMENT_KINDS = ['wall', 'window', 'entrance', 'bar', 'kitchen', 'wc', 'plant', 'column', 'zone', 'label'];

const roomSchema = new mongoose.Schema({
  businessId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  name:        { type: String, required: true },
  capacity:    { type: Number, required: true, min: 1 },
  description: { type: String, default: '' },
  // What else is drawn on the floor plan: walls, the bar, the entrance… (x/y
  // are the top-left corner before rotating; w/h the size; angle in degrees).
  elements: [{
    kind:  { type: String, enum: ELEMENT_KINDS, required: true },
    x:     { type: Number, default: 0 },
    y:     { type: Number, default: 0 },
    w:     { type: Number, default: 120, min: 4, max: 4000 },
    h:     { type: Number, default: 40, min: 4, max: 4000 },
    angle: { type: Number, default: 0, min: 0, max: 359 },
    label: { type: String, default: '', maxlength: 60 },
  }],
}, { timestamps: true });

roomSchema.index({ businessId: 1 });

module.exports = mongoose.model('Room', roomSchema);
module.exports.ELEMENT_KINDS = ELEMENT_KINDS;
