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

    seoTitle: { type: String, default: '' },
    metaDescription: { type: String, default: '' },
    keywords: { type: String, default: '' },

    // Duplicate index warning fix:
    // Yahan unique + sparse hai, neeche schema.index({ slug: 1 }) dobara mat lagana.
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
    },

    ogImage: { type: String, default: '' },
    canonicalUrl: { type: String, default: '' },
    robots: { type: String, default: 'index, follow' },

    status: {
      type: String,
      enum: ['Active', 'Expired'],
      default: 'Active',
    },
  },
  { timestamps: true }
);

// Useful indexes only. Slug ka index dobara mat lagao.
examSchema.index({ status: 1, lastDate: -1 });
examSchema.index({ category: 1, status: 1 });
examSchema.index({
  title: 'text',
  department: 'text',
  keywords: 'text',
  shortInfo: 'text',
});

module.exports = mongoose.model('Exam', examSchema);