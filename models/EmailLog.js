const mongoose = require('mongoose');

const emailLogSchema = new mongoose.Schema(
  {
    provider: { type: String, default: 'resend', index: true },
    source: { type: String, required: true, index: true },
    status: { type: String, enum: ['sent', 'failed'], required: true, index: true },

    from: { type: String, default: '' },
    to: [{ type: String }],
    cc: [{ type: String }],
    bcc: [{ type: String }],
    replyTo: { type: String, default: '' },
    subject: { type: String, default: '' },
    html: { type: String, default: '' },

    providerMessageId: { type: String, default: '' },
    errorMessage: { type: String, default: '' },
    errorRaw: { type: mongoose.Schema.Types.Mixed, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

emailLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('EmailLog', emailLogSchema);

