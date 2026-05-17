const mongoose = require('mongoose');

const liveRequestEventSchema = new mongoose.Schema({
  requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveRequest', index: true },
  firebaseRequestId: { type: String, trim: true, index: true },

  type: { type: String, required: true, index: true },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'LiveAgent', default: null },
  agentEmployeeId: { type: String, trim: true },
  userId: { type: String, trim: true },
  meta: { type: Object, default: {} },
}, { timestamps: true });

module.exports = mongoose.model('LiveRequestEvent', liveRequestEventSchema);
