const mongoose = require('mongoose');

const liveChatMessageSchema = new mongoose.Schema(
  {
    senderId: {
      type: String,
      default: '',
      trim: true,
    },
    senderName: {
      type: String,
      default: '',
      trim: true,
    },
    senderType: {
      type: String,
      enum: ['student', 'agent', 'admin', 'system'],
      default: 'student',
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const liveChatSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    requestId: {
      type: String,
      default: '',
      index: true,
      trim: true,
    },
    firebaseRequestId: {
      type: String,
      default: '',
      index: true,
      trim: true,
    },
    studentId: {
      type: String,
      default: '',
      index: true,
      trim: true,
    },
    agentId: {
      type: String,
      default: '',
      index: true,
      trim: true,
    },
    studentName: {
      type: String,
      default: 'Student',
      trim: true,
    },
    agentName: {
      type: String,
      default: 'Expert Agent',
      trim: true,
    },
    isClosed: {
      type: Boolean,
      default: false,
      index: true,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    messages: [liveChatMessageSchema],
  },
  { timestamps: true }
);

liveChatSchema.index({ updatedAt: -1 });
liveChatSchema.index({ roomId: 1, updatedAt: -1 });

module.exports = mongoose.model('LiveChat', liveChatSchema);
