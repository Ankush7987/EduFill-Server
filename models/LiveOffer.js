const mongoose = require('mongoose');

const liveOfferSchema = new mongoose.Schema({
  requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveRequest', required: true, index: true },
  firebaseRequestId: { type: String, trim: true, index: true },

  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveAgent', required: true, index: true },
  agentEmployeeId: { type: String, trim: true, index: true },
  agentName: { type: String, trim: true },

  status: {
    type: String,
    enum: ['Sent', 'Accepted', 'Skipped', 'Timed Out', 'Expired'],
    default: 'Sent',
    index: true,
  },
  expiresAt: { type: Date, required: true, index: true },
  respondedAt: { type: Date, default: null },
  reason: { type: String, default: null },
}, { timestamps: true });

liveOfferSchema.index({ requestId: 1, agentId: 1, createdAt: -1 });

module.exports = mongoose.model('LiveOffer', liveOfferSchema);
