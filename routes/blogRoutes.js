const express = require('express');
const router = express.Router();
const Blog = require('../models/Blog');

const isMongoId = (value) => /^[0-9a-fA-F]{24}$/.test(String(value || ''));

const createSlug = (title = '') =>
  String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');

const normalizeKeywords = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join(', ');
  }
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const buildPayload = (body = {}) => ({
  title: String(body.title || '').trim(),
  slug: String(body.slug || createSlug(body.title)).trim().toLowerCase(),
  excerpt: String(body.excerpt || '').trim(),
  coverImage: String(body.coverImage || '').trim(),
  category: body.category || 'Exam Updates',
  seoKeywords: normalizeKeywords(body.seoKeywords),
  status: body.status === 'Draft' ? 'Draft' : 'Published',
  content: body.content || '',
});

const findBlogQuery = (idOrSlug) => {
  if (isMongoId(idOrSlug)) return { _id: idOrSlug };
  return { slug: idOrSlug };
};

const buildListFilter = (query = {}) => {
  const includeDrafts = query.admin === 'true' || query.includeDrafts === 'true' || query.status === 'all';
  const filter = includeDrafts ? {} : { status: query.status === 'Draft' ? 'Draft' : 'Published' };

  if (query.category && query.category !== 'All') {
    filter.category = String(query.category);
  }

  const search = String(query.search || '').trim();
  if (search) {
    // Fast enough for medium scale. For very high scale, add Atlas Search later.
    filter.$or = [
      { title: { $regex: search, $options: 'i' } },
      { excerpt: { $regex: search, $options: 'i' } },
      { category: { $regex: search, $options: 'i' } },
      { seoKeywords: { $regex: search, $options: 'i' } },
    ];
  }

  return filter;
};

const pickBlogFields = 'title slug excerpt coverImage category author status createdAt updatedAt';

router.get('/meta', async (req, res) => {
  try {
    const filter = { status: 'Published' };

    const [total, grouped] = await Promise.all([
      Blog.countDocuments(filter),
      Blog.aggregate([
        { $match: filter },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
    ]);

    const categoryCounts = {};
    grouped.forEach((item) => {
      categoryCounts[item._id || 'Uncategorized'] = item.count;
    });

    return res.json({ success: true, total, categoryCounts });
  } catch (error) {
    console.error('GET /api/blogs/meta error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch blog meta.' });
  }
});

router.get('/admin', async (req, res) => {
  try {
    const blogs = await Blog.find({})
      .select(`${pickBlogFields} content seoKeywords`)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    return res.json(blogs);
  } catch (error) {
    console.error('GET /api/blogs/admin error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch admin blogs.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit || '12', 10)));
    const skip = (page - 1) * limit;

    const filter = buildListFilter(req.query);
    const sort = { createdAt: -1, _id: -1 };

    const [blogs, total] = await Promise.all([
      Blog.find(filter)
        .select(pickBlogFields)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Blog.countDocuments(filter),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.json({
      success: true,
      blogs,
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages,
    });
  } catch (error) {
    console.error('GET /api/blogs error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch blogs.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const payload = buildPayload(req.body);

    if (!payload.title || !payload.slug || !payload.excerpt || !payload.content) {
      return res.status(400).json({
        success: false,
        message: 'Title, slug, excerpt and content are required.',
      });
    }

    const duplicate = await Blog.findOne({ slug: payload.slug }).lean();
    if (duplicate) {
      return res.status(409).json({ success: false, message: 'Slug already exists. Please use a different slug.' });
    }

    const blog = await Blog.create(payload);
    return res.status(201).json({ success: true, blog });
  } catch (error) {
    console.error('POST /api/blogs error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to create blog.' });
  }
});

router.get('/:idOrSlug', async (req, res) => {
  try {
    const blog = await Blog.findOne(findBlogQuery(req.params.idOrSlug)).lean();

    if (!blog) return res.status(404).json({ success: false, message: 'Blog not found.' });

    return res.json(blog);
  } catch (error) {
    console.error('GET /api/blogs/:idOrSlug error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch blog.' });
  }
});

router.put('/:idOrSlug', async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const query = findBlogQuery(req.params.idOrSlug);

    if (!payload.title || !payload.slug || !payload.excerpt || !payload.content) {
      return res.status(400).json({
        success: false,
        message: 'Title, slug, excerpt and content are required.',
      });
    }

    const existingWithSlug = await Blog.findOne({ slug: payload.slug }).lean();
    const currentId = isMongoId(req.params.idOrSlug) ? String(req.params.idOrSlug) : null;

    if (
      existingWithSlug &&
      (
        (currentId && String(existingWithSlug._id) !== currentId) ||
        (!currentId && existingWithSlug.slug !== req.params.idOrSlug)
      )
    ) {
      return res.status(409).json({ success: false, message: 'Slug already exists on another blog.' });
    }

    const blog = await Blog.findOneAndUpdate(query, payload, {
      returnDocument: 'after',
      runValidators: true,
    });

    if (!blog) return res.status(404).json({ success: false, message: 'Blog not found for update.' });

    return res.json({ success: true, blog });
  } catch (error) {
    console.error('PUT /api/blogs/:idOrSlug error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to update blog.' });
  }
});

router.patch('/:idOrSlug', async (req, res) => {
  try {
    const allowed = {};

    ['title', 'slug', 'excerpt', 'coverImage', 'category', 'status', 'content'].forEach((key) => {
      if (req.body[key] !== undefined) allowed[key] = req.body[key];
    });

    if (req.body.seoKeywords !== undefined) allowed.seoKeywords = normalizeKeywords(req.body.seoKeywords);
    if (allowed.slug) allowed.slug = String(allowed.slug).trim().toLowerCase();

    const blog = await Blog.findOneAndUpdate(findBlogQuery(req.params.idOrSlug), allowed, {
      returnDocument: 'after',
      runValidators: true,
    });

    if (!blog) return res.status(404).json({ success: false, message: 'Blog not found for update.' });

    return res.json({ success: true, blog });
  } catch (error) {
    console.error('PATCH /api/blogs/:idOrSlug error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to update blog.' });
  }
});

router.patch('/:idOrSlug/status', async (req, res) => {
  try {
    const status = req.body.status === 'Draft' ? 'Draft' : 'Published';

    const blog = await Blog.findOneAndUpdate(
      findBlogQuery(req.params.idOrSlug),
      { status },
      { returnDocument: 'after', runValidators: true }
    );

    if (!blog) return res.status(404).json({ success: false, message: 'Blog not found for status update.' });

    return res.json({ success: true, blog });
  } catch (error) {
    console.error('PATCH /api/blogs/:idOrSlug/status error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update blog status.' });
  }
});

router.delete('/:idOrSlug', async (req, res) => {
  try {
    const blog = await Blog.findOneAndDelete(findBlogQuery(req.params.idOrSlug));

    if (!blog) return res.status(404).json({ success: false, message: 'Blog not found for delete.' });

    return res.json({ success: true, message: 'Blog deleted successfully.', blog });
  } catch (error) {
    console.error('DELETE /api/blogs/:idOrSlug error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete blog.' });
  }
});

module.exports = router;
