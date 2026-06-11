const mongoose = require('mongoose');

const blogSchema = new mongoose.Schema({
  // Content Fields
  title: { type: String, required: true },
  slug: { type: String, required: true, unique: true, index: true }, 
  content: { type: String, required: true }, 
  excerpt: { type: String, maxLength: 320 }, // Increased to allow flexible UI displays
  
  // Image SEO
  coverImage: { type: String, default: 'https://edufills.com/default-blog.jpg' },
  coverImageAlt: { type: String, default: 'EduFill Blog Post' }, // NEW: Critical for Google Images

  // Categorization
  category: { type: String, default: 'Updates', index: true }, // Added index for faster category filtering
  tags: [{ type: String }], // NEW: Better than a single string for internal linking algorithms
  
  // Advanced SEO Meta Fields
  metaTitle: { type: String, maxLength: 60 }, // NEW: Exact SEO Title (Defaults to title if empty)
  metaDescription: { type: String, maxLength: 160 }, // NEW: Exact SEO Description (Defaults to excerpt)
  canonicalUrl: { type: String }, // NEW: Prevents duplicate content penalties if cross-posted
  
  // E-E-A-T Author Schema Fields
  author: { 
    name: { type: String, default: 'EduFill Experts' },
    url: { type: String } // NEW: Link to author's LinkedIn or internal profile
  },

  // Readability Signal
  readingTime: { type: Number, default: 5 }, // NEW: Helps UI display "5 min read", reducing bounce rates

  status: { type: String, enum: ['Draft', 'Published'], default: 'Published', index: true },
}, { timestamps: true });

// Compound index for fast querying of published blogs by category
blogSchema.index({ status: 1, category: 1, createdAt: -1 });

module.exports = mongoose.model('Blog', blogSchema);