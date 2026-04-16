const mongoose = require('mongoose');

const collegeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    course: { type: String, required: true },
    state: { type: String, default: "India" },
    exam: { type: String, default: "NEET" },
    // 🌟 NAYA SCHEMA: Ek hi college me saari categories!
    cutoffs: {
        General: { type: Number, default: 0 },
        OBC: { type: Number, default: 0 },
        EWS: { type: Number, default: 0 },
        SC: { type: Number, default: 0 },
        ST: { type: Number, default: 0 }
    }
});

module.exports = mongoose.model('College', collegeSchema);