const mongoose = require('mongoose');

const examSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    category: { type: String, default: 'Government' },

    shortInfo: { type: String, default: '' },
    notificationNumber: { type: String, default: '' },

    postDate: { type: Date },
    startDate: { type: Date },
    lastDate: { type: Date },
    payFeeLastDate: { type: Date },

    examDate: { type: String, default: '' },
    admitCardDate: { type: String, default: '' },

    applicationFee: { type: String, default: '' },
    paymentMode: { type: String, default: '' },
    ageLimit: { type: String, default: '' },
    totalVacancies: { type: String, default: '' },
    qualification: { type: String, default: '' },
    howToApply: { type: String, default: '' },
    importantInstructions: { type: String, default: '' },

    officialLink: { type: String, default: '' },
    applyOnlineLink: { type: String, default: '' },
    notificationLink: { type: String, default: '' },
    syllabusLink: { type: String, default: '' },
    officialWebsite: { type: String, default: '' },

    // 🔥 100% ADVANCED SEO FIELDS 🔥
    seoTitle: { type: String, default: '' },       // Recommended: Under 60 characters
    metaDescription: { type: String, default: '' }, // Recommended: Under 160 characters
    keywords: { type: String, default: '' },        // LSI keywords target
    
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
    },

    ogImage: { type: String, default: '' }, // OpenGraph Social Share Image
    canonicalUrl: { type: String, default: '' }, // Prevents duplicate content penalty
    robots: { type: String, default: 'index, follow' },
    
    // Google Schema.org structured data block (Auto-populated by backend)
    structuredData: { type: Object, default: {} },

    status: {
      type: String,
      enum: ['Active', 'Expired'],
      default: 'Active',
    },
  },
  { timestamps: true }
);

// High-Performance Compound Indexes for fast crawler discovery
examSchema.index({ status: 1, lastDate: -1 });
examSchema.index({ category: 1, status: 1 });
examSchema.index({ slug: 1 }, { unique: true }); // Fast index for clean routing
examSchema.index({
  title: 'text',
  department: 'text',
  keywords: 'text',
  shortInfo: 'text',
});

module.exports = mongoose.model('Exam', examSchema);