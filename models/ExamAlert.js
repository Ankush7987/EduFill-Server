const mongoose = require('mongoose');

const examAlertSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true }, 
  department: { type: String, required: true, trim: true }, 
  category: { type: String, default: 'Govt Job' }, 
  
  startDate: { type: Date }, 
  lastDate: { type: Date, required: true },
  examDate: { type: String, default: '' }, 
  applicationFee: { type: String, default: '' }, 
  ageLimit: { type: String, default: '' }, 
  totalVacancies: { type: String, default: '' }, 
  qualification: { type: String, default: '' }, 
  
  officialLink: { type: String, required: true }, 
  status: { type: String, enum: ['Active', 'Expired'], default: 'Active' },

  // 🔥 SEO Multiplier for Live Alerts Tracker
  slug: { type: String, lowercase: true, trim: true },
  seoKeywords: { type: String, default: '' }
}, { timestamps: true });

// Index for instant crawler acceleration
examAlertSchema.index({ status: 1, lastDate: -1 });
examAlertSchema.index({ title: 'text', department: 'text', seoKeywords: 'text' });

module.exports = mongoose.model('ExamAlert', examAlertSchema);