const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const Blog = require('../models/Blog');

const MAX_TITLE_LENGTH = 180;
const MAX_SLUG_LENGTH = 220;
const MAX_EXCERPT_LENGTH = 320;
const MAX_CATEGORY_LENGTH = 80;
const MAX_KEYWORDS_LENGTH = 500;
const MAX_COVER_IMAGE_LENGTH = 1200;
const MAX_CONTENT_LENGTH = 250000;

const BLOG_LIST_FIELDS = 'title slug excerpt coverImage category author status createdAt updatedAt';

const VALID_STATUSES = new Set(['Published', 'Draft']);

const isMongoId = (value) => /^[0-9a-fA-F]{24}$/.test(String(value || ''));

const sanitizeString = (value, maxLength = 500) => {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
};

const sanitizeContent = (value) => {
  return String(value || '').trim().slice(0, MAX_CONTENT_LENGTH);
};

const escapeRegex = (value) => {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const createSlug = (title = '') => {
  return String(title || '')
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, MAX_SLUG_LENGTH);
};

const normalizeSlug = (slug, title) => {
  const rawSlug = sanitizeString(slug || createSlug(title), MAX_SLUG_LENGTH)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');

  return rawSlug || createSlug(title);
};

const normalizeKeywords = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeString(item, 80))
      .filter(Boolean)
      .join(', ')
      .slice(0, MAX_KEYWORDS_LENGTH);
  }

  if (value === null || value === undefined) {
    return '';
  }

  return sanitizeString(value, MAX_KEYWORDS_LENGTH);
};

const normalizeStatus = (value) => {
  return value === 'Draft' ? 'Draft' : 'Published';
};

const buildPayload = (body = {}) => {
  const title = sanitizeString(body.title, MAX_TITLE_LENGTH);
  const slug = normalizeSlug(body.slug, title);

  return {
    title,
    slug,
    excerpt: sanitizeString(body.excerpt, MAX_EXCERPT_LENGTH),
    coverImage: sanitizeString(body.coverImage, MAX_COVER_IMAGE_LENGTH),
    category: sanitizeString(body.category, MAX_CATEGORY_LENGTH) || 'Exam Updates',
    seoKeywords: normalizeKeywords(body.seoKeywords),
    status: normalizeStatus(body.status),
    content: sanitizeContent(body.content),
  };
};

const buildPatchPayload = (body = {}) => {
  const allowed = {};

  if (body.title !== undefined) {
    allowed.title = sanitizeString(body.title, MAX_TITLE_LENGTH);
  }

  if (body.slug !== undefined) {
    allowed.slug = normalizeSlug(body.slug, body.title || '');
  }

  if (body.excerpt !== undefined) {
    allowed.excerpt = sanitizeString(body.excerpt, MAX_EXCERPT_LENGTH);
  }

  if (body.coverImage !== undefined) {
    allowed.coverImage = sanitizeString(body.coverImage, MAX_COVER_IMAGE_LENGTH);
  }

  if (body.category !== undefined) {
    allowed.category = sanitizeString(body.category, MAX_CATEGORY_LENGTH) || 'Exam Updates';
  }

  if (body.status !== undefined) {
    allowed.status = normalizeStatus(body.status);
  }

  if (body.content !== undefined) {
    allowed.content = sanitizeContent(body.content);
  }

  if (body.seoKeywords !== undefined) {
    allowed.seoKeywords = normalizeKeywords(body.seoKeywords);
  }

  return allowed;
};

const findBlogQuery = (idOrSlug) => {
  const cleanValue = sanitizeString(idOrSlug, MAX_SLUG_LENGTH);

  if (isMongoId(cleanValue)) {
    return { _id: cleanValue };
  }

  return {
    slug: cleanValue.toLowerCase(),
  };
};

const buildPublicListFilter = (query = {}) => {
  const filter = {
    status: 'Published',
  };

  const category = sanitizeString(query.category, MAX_CATEGORY_LENGTH);

  if (category && category !== 'All') {
    filter.category = category;
  }

  const search = sanitizeString(query.search, 80);

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');

    filter.$or = [
      { title: regex },
      { excerpt: regex },
      { category: regex },
      { seoKeywords: regex },
    ];
  }

  return filter;
};

const getBearerToken = (req) => {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    return '';
  }

  return header.replace('Bearer ', '').trim();
};

const verifyBlogAdmin = (req, res, next) => {
  const expectedToken = String(process.env.BLOG_ADMIN_TOKEN || '').trim();

  if (!expectedToken) {
    return res.status(500).json({
      success: false,
      message: 'BLOG_ADMIN_TOKEN is not configured on server.',
    });
  }

  const receivedToken = getBearerToken(req);

  if (!receivedToken) {
    return res.status(401).json({
      success: false,
      message: 'Admin authorization token is required.',
    });
  }

  const expectedBuffer = Buffer.from(expectedToken);
  const receivedBuffer = Buffer.from(receivedToken);

  const isValid =
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

  if (!isValid) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized admin access.',
    });
  }

  next();
};

const validateRequiredBlogFields = (payload) => {
  if (!payload.title) return 'Title is required.';
  if (!payload.slug) return 'Slug is required.';
  if (!payload.excerpt) return 'Excerpt is required.';
  if (!payload.content) return 'Content is required.';

  return '';
};

const checkDuplicateSlug = async ({ slug, currentIdOrSlug = '' }) => {
  const existingWithSlug = await Blog.findOne({ slug }).select('_id slug').lean();

  if (!existingWithSlug) {
    return false;
  }

  const currentValue = sanitizeString(currentIdOrSlug, MAX_SLUG_LENGTH);

  if (!currentValue) {
    return true;
  }

  if (isMongoId(currentValue)) {
    return String(existingWithSlug._id) !== currentValue;
  }

  return existingWithSlug.slug !== currentValue.toLowerCase();
};

router.get('/meta', async (req, res) => {
  try {
    const filter = { status: 'Published' };

    const [total, grouped] = await Promise.all([
      Blog.countDocuments(filter),
      Blog.aggregate([
        { $match: filter },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const categoryCounts = {};

    grouped.forEach((item) => {
      categoryCounts[item._id || 'Uncategorized'] = item.count;
    });

    return res.status(200).json({
      success: true,
      total,
      categoryCounts,
    });
  } catch (error) {
    console.error('GET /api/blogs/meta error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch blog meta.',
    });
  }
});

router.get('/admin', verifyBlogAdmin, async (req, res) => {
  try {
    const blogs = await Blog.find({})
      .select(`${BLOG_LIST_FIELDS} content seoKeywords`)
      .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      blogs,
      data: blogs,
      total: blogs.length,
    });
  } catch (error) {
    console.error('GET /api/blogs/admin error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch admin blogs.',
    });
  }
});

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit || '12', 10)));
    const skip = (page - 1) * limit;

    const filter = buildPublicListFilter(req.query);
    const sort = { createdAt: -1, _id: -1 };

    const [blogs, total] = await Promise.all([
      Blog.find(filter)
        .select(BLOG_LIST_FIELDS)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Blog.countDocuments(filter),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.status(200).json({
      success: true,
      blogs,
      data: blogs,
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages,
    });
  } catch (error) {
    console.error('GET /api/blogs error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch blogs.',
    });
  }
});

router.post('/', verifyBlogAdmin, async (req, res) => {
  try {
    const payload = buildPayload(req.body);

    const validationError = validateRequiredBlogFields(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const duplicate = await Blog.findOne({ slug: payload.slug }).select('_id').lean();

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'Slug already exists. Please use a different slug.',
      });
    }

    const blog = await Blog.create(payload);

    return res.status(201).json({
      success: true,
      message: 'Blog created successfully.',
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('POST /api/blogs error:', error.message);

    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to create blog.',
    });
  }
});

router.get('/:idOrSlug', async (req, res) => {
  try {
    const query = {
      ...findBlogQuery(req.params.idOrSlug),
      status: 'Published',
    };

    const blog = await Blog.findOne(query).lean();

    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found.',
      });
    }

    return res.status(200).json({
      success: true,
      blog,
      data: blog,
      ...blog,
    });
  } catch (error) {
    console.error('GET /api/blogs/:idOrSlug error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch blog.',
    });
  }
});

router.put('/:idOrSlug', verifyBlogAdmin, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const validationError = validateRequiredBlogFields(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const isDuplicate = await checkDuplicateSlug({
      slug: payload.slug,
      currentIdOrSlug: req.params.idOrSlug,
    });

    if (isDuplicate) {
      return res.status(409).json({
        success: false,
        message: 'Slug already exists on another blog.',
      });
    }

    const blog = await Blog.findOneAndUpdate(findBlogQuery(req.params.idOrSlug), payload, {
      new: true,
      runValidators: true,
    });

    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found for update.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Blog updated successfully.',
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('PUT /api/blogs/:idOrSlug error:', error.message);

    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to update blog.',
    });
  }
});

router.patch('/:idOrSlug', verifyBlogAdmin, async (req, res) => {
  try {
    const allowed = buildPatchPayload(req.body);

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided for update.',
      });
    }

    if (allowed.slug) {
      const isDuplicate = await checkDuplicateSlug({
        slug: allowed.slug,
        currentIdOrSlug: req.params.idOrSlug,
      });

      if (isDuplicate) {
        return res.status(409).json({
          success: false,
          message: 'Slug already exists on another blog.',
        });
      }
    }

    const blog = await Blog.findOneAndUpdate(findBlogQuery(req.params.idOrSlug), allowed, {
      new: true,
      runValidators: true,
    });

    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found for update.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Blog updated successfully.',
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('PATCH /api/blogs/:idOrSlug error:', error.message);

    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to update blog.',
    });
  }
});

router.patch('/:idOrSlug/status', verifyBlogAdmin, async (req, res) => {
  try {
    const status = normalizeStatus(req.body.status);

    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid blog status.',
      });
    }

    const blog = await Blog.findOneAndUpdate(
      findBlogQuery(req.params.idOrSlug),
      { status },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found for status update.',
      });
    }

    return res.status(200).json({
      success: true,
      message: `Blog moved to ${status}.`,
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('PATCH /api/blogs/:idOrSlug/status error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to update blog status.',
    });
  }
});

router.delete('/:idOrSlug', verifyBlogAdmin, async (req, res) => {
  try {
    const blog = await Blog.findOneAndDelete(findBlogQuery(req.params.idOrSlug));

    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found for delete.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Blog deleted successfully.',
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('DELETE /api/blogs/:idOrSlug error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to delete blog.',
    });
  }
});

module.exports = router;