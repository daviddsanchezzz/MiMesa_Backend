const mongoose = require('mongoose');

// The escandallo of a dish: what goes into one serving. Quantities are in the ingredient's own unit
// (kg, l or ud); wastePct is what is lost when preparing it (peeling, trimming), so 100 g usable
// out of a 20 % waste ingredient costs for 125 g.
const lineSchema = new mongoose.Schema({
  ingredientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true },
  quantity: { type: Number, required: true, min: 0 },
  wastePct: { type: Number, default: 0, min: 0, max: 90 },
}, { _id: false });

const recipeSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },   // the dish in the carta
  lines: { type: [lineSchema], default: [] },
  otherCost: { type: Number, default: 0, min: 0 },    // what is not an ingredient: bread, gas, packaging (€ per serving)
}, { timestamps: true });

recipeSchema.index({ businessId: 1, itemId: 1 }, { unique: true });
recipeSchema.index({ businessId: 1, 'lines.ingredientId': 1 });

module.exports = mongoose.model('Recipe', recipeSchema);
