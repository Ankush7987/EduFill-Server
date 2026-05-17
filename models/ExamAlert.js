const mongoose = require('mongoose');

const examAlertSchema = new mongoose.Schema({
  title: { type: String, required: true }, 
  department: { type: String, required: true }, 
  category: { type: String, default: 'Govt Job' }, 
  
  // Naye Sarkari Result wale fields 👇
  startDate: { type: Date }, 
  lastDate: { type: Date, required: true },
  examDate: { type: String }, // e.g., "Notify Later" or "15 July 2026"
  applicationFee: { type: String }, // e.g., "Gen/OBC: ₹100 | SC/ST: ₹0"
  ageLimit: { type: String }, // e.g., "18-27 Years"
  totalVacancies: { type: String }, // e.g., "7500+"
  qualification: { type: String }, // e.g., "Bachelor Degree in Any Stream"
  
  officialLink: { type: String, required: true }, 
  status: { type: String, enum: ['Active', 'Expired'], default: 'Active' }
}, { timestamps: true });

module.exports = mongoose.model('ExamAlert', examAlertSchema);