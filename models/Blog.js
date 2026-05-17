const mongoose = require('mongoose');

const blogSchema = new mongoose.Schema({
  title: { type: String, required: true },
  slug: { type: String, required: true, unique: true, index: true }, 
  content: { type: String, required: true }, 
  excerpt: { type: String, maxLength: 200 }, 
  coverImage: { type: String, default: 'https://edufills.com/default-blog.jpg' },
  category: { type: String, default: 'Updates' }, 
  seoKeywords: { type: String },
  status: { type: String, enum: ['Draft', 'Published'], default: 'Published' },
  author: { type: String, default: 'EduFill Experts' },
}, { timestamps: true });

module.exports = mongoose.model('Blog', blogSchema);