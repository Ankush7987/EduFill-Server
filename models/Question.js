const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
    exam: { type: String, required: true, default: 'NEET' },
    year: { type: Number, required: true },
    subject: { type: String, required: true }, // Physics, Chemistry, Biology
    text: { type: String, required: true }, // Question ka text
    options: [{ type: String, required: true }], // 4 options ki array
    correctOptionIndex: { type: Number, required: true }, // 0, 1, 2, or 3
    explanation: { type: String, default: 'Detailed solution will be updated soon.' }
});

module.exports = mongoose.model('Question', questionSchema);