const mongoose = require('mongoose');

const liveChatSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  studentName: String,
  agentName: String,
  messages: [
    {
      senderId: String,
      senderType: { type: String, enum: ['student', 'agent'] },
      text: String,
      timestamp: { type: Date, default: Date.now }
    }
  ]
});

module.exports = mongoose.model('LiveChat', liveChatSchema);