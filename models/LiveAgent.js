const mongoose = require('mongoose');

const liveAgentSchema = new mongoose.Schema({
  // Existing Firestore Employees document id can be stored here.
  employeeId: { type: String, trim: true, index: true, unique: true, sparse: true },

  name: { type: String, trim: true, required: true },
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },

  institute: { type: String, default: 'Online', index: true },
  agentType: { type: String, default: 'online', enum: ['online', 'camp'], index: true },
  skills: { type: [String], default: ['ALL'], index: true },

  active: { type: Boolean, default: true, index: true },
  onBreak: { type: Boolean, default: false, index: true },

  isLiveOnline: { type: Boolean, default: false, index: true },
  liveStatus: { type: String, default: 'offline', enum: ['online', 'offline'], index: true },

  // Agent becomes busy only after accepting the request, not when offer is sent.
  isBusy: { type: Boolean, default: false, index: true },
  currentLiveRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveRequest', default: null },

  lastHeartbeatAt: { type: Date, default: null, index: true },
  lastLiveOfferAt: { type: Date, default: null, index: true },

  assignedCount: { type: Number, default: 0 },
  todayAcceptedCount: { type: Number, default: 0 },
  todayCompletedCount: { type: Number, default: 0 },

  skipCount: { type: Number, default: 0 },
  completionRate: { type: Number, default: 1 },
  avgResponseMs: { type: Number, default: 0 },
}, { timestamps: true });

liveAgentSchema.index({
  agentType: 1,
  active: 1,
  isLiveOnline: 1,
  isBusy: 1,
  onBreak: 1,
  lastHeartbeatAt: 1,
  lastLiveOfferAt: 1,
});

module.exports = mongoose.model('LiveAgent', liveAgentSchema);
