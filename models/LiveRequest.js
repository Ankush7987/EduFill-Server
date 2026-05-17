const mongoose = require('mongoose');

const LIVE_REQUEST_STATUS = {
  SEARCHING: 'Searching',
  OFFERED: 'Offered',
  ACCEPTED: 'Accepted',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
};

const liveRequestSchema = new mongoose.Schema({
  // Firebase/Firestore compatibility.
  firebaseRequestId: { type: String, trim: true, index: true, unique: true, sparse: true },
  firebaseUserId: { type: String, trim: true, index: true },

  userId: { type: String, trim: true, index: true },
  userEmail: { type: String, trim: true, lowercase: true },
  userPhone: { type: String, trim: true },

  name: { type: String, trim: true, required: true },
  mobile: { type: String, trim: true, required: true },
  exam: { type: String, trim: true, required: true, index: true },

  documents: { type: Object, default: {} },
  vaultDocuments: { type: Object, default: {} },
  hasUploadedDocuments: { type: Boolean, default: false },

  status: {
    type: String,
    enum: Object.values(LIVE_REQUEST_STATUS),
    default: LIVE_REQUEST_STATUS.SEARCHING,
    index: true,
  },

  // Current 10-sec offer.
  offerAgentId: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveAgent', default: null, index: true },
  offerAgentEmployeeId: { type: String, trim: true, index: true },
  offerAgentName: { type: String, trim: true },
  offerStartedAt: { type: Date, default: null },
  offerExpiresAt: { type: Date, default: null, index: true },
  offerToken: { type: String, trim: true },

  // Accepted agent.
  acceptedAgentId: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveAgent', default: null, index: true },
  acceptedAgentEmployeeId: { type: String, trim: true },
  acceptedAgentName: { type: String, trim: true },
  acceptedAt: { type: Date, default: null },

  skippedAgentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'LiveAgent' }],
  skippedEmployeeIds: [{ type: String }],
  skippedAgentNames: [{ type: String }],

  applicationNumber: { type: String, default: null },
  completedAt: { type: Date, default: null },
  completedByAgentId: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveAgent', default: null },
  completedByAgentName: { type: String, default: null },

  cancelledAt: { type: Date, default: null },
  cancelReason: { type: String, default: null },

  noAgentAvailable: { type: Boolean, default: false },
  routingStatus: { type: String, default: 'searching' },
  lastRoutingAt: { type: Date, default: null },
}, { timestamps: true });

liveRequestSchema.index({ status: 1, createdAt: 1 });
liveRequestSchema.index({ status: 1, offerExpiresAt: 1 });
liveRequestSchema.index({ firebaseUserId: 1, status: 1 });
liveRequestSchema.index({ offerAgentEmployeeId: 1, status: 1 });
liveRequestSchema.index({ acceptedAgentEmployeeId: 1, status: 1 });

liveRequestSchema.statics.STATUS = LIVE_REQUEST_STATUS;

module.exports = mongoose.model('LiveRequest', liveRequestSchema);
module.exports.LIVE_REQUEST_STATUS = LIVE_REQUEST_STATUS;
