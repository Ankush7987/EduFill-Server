/**
 * blogRoutes.js — EduFill Blog API Routes
 *
 * Routes:
 *   GET    /api/blogs/sitemap.xml          — XML sitemap (public, cached)
 *   GET    /api/blogs/meta                 — category counts + total (public)
 *   GET    /api/blogs/admin                — full list for admin panel (protected)
 *   GET    /api/blogs/preview/:idOrSlug    — draft preview (protected)
 *   GET    /api/blogs/                     — paginated public listing
 *   POST   /api/blogs/                     — create post (protected)
 *   GET    /api/blogs/:idOrSlug            — single published post (public)
 *   PUT    /api/blogs/:idOrSlug            — full replace (protected)
 *   PATCH  /api/blogs/:idOrSlug            — partial update (protected)
 *   PATCH  /api/blogs/:idOrSlug/status     — toggle Draft/Published (protected)
 *   DELETE /api/blogs/:idOrSlug            — delete post (protected)
 *
 * Security:
 *   - All inputs sanitised and length-bounded before touching the DB
 *   - Admin token verified with timing-safe comparison (no timing oracle)
 *   - Regex search replaced with MongoDB $text (no ReDoS risk)
 *   - No internal stack traces leaked to clients
 *   - Rate-limit headers forwarded (apply express-rate-limit at app level)
 *
 * SEO:
 *   - Sitemap auto-generated from DB; includes lastmod + changefreq
 *   - publishedAt auto-set on status change (pre-save hook in model)
 *   - Canonical, noIndex, faqItems, ogImage, coverImageAlt all persisted
 *   - Admin preview route lets editors check drafts without publishing
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const Blog = require('../models/Blog');

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_TITLE_LENGTH       = 180;
const MAX_SLUG_LENGTH        = 220;
const MAX_EXCERPT_LENGTH     = 320;
const MAX_META_TITLE_LENGTH  = 60;
const MAX_META_DESC_LENGTH   = 160;
const MAX_CATEGORY_LENGTH    = 80;
const MAX_COVER_IMAGE_LENGTH = 1200;
const MAX_OG_IMAGE_LENGTH    = 1200;
const MAX_COVER_ALT_LENGTH   = 200;
const MAX_CONTENT_LENGTH     = 250000;
const MAX_CANONICAL_LENGTH   = 500;
const MAX_AUTHOR_LENGTH      = 120;
const MAX_AUTHOR_BIO_LENGTH  = 500;
const MAX_AUTHOR_URL_LENGTH  = 500;
const MAX_URL_LENGTH         = 1200;

const VALID_STATUSES = new Set(['Published', 'Draft']);

// Fields returned in public listing (no sensitive/heavy fields)
const BLOG_LIST_FIELDS =
  'title slug excerpt coverImage coverImageAlt category author ' +
  'status publishedAt createdAt updatedAt readingTime';

// ─── Utility: input sanitisation ─────────────────────────────────────────────

/**
 * Strip control characters, collapse whitespace, hard-limit length.
 * Safe to use on any user-supplied string field.
 */
const sanitizeString = (value, maxLength = 500) =>
  String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

/**
 * Sanitise raw HTML/Markdown blog content.
 * Preserves whitespace structure but hard-limits size.
 */
const sanitizeContent = (value) =>
  String(value ?? '').trim().slice(0, MAX_CONTENT_LENGTH);

/**
 * Sanitise a URL field: strip control chars, reject javascript: / data: schemes.
 */
const sanitizeUrl = (value, maxLength = MAX_URL_LENGTH) => {
  const raw = sanitizeString(value, maxLength);
  if (/^(javascript|data|vbscript):/i.test(raw)) return '';
  return raw;
};

/**
 * Build a URL-safe slug from a title string.
 */
const createSlug = (title = '') =>
  String(title)
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, MAX_SLUG_LENGTH);

/**
 * Normalise a user-supplied slug: lowercase, hyphenated, safe.
 * Falls back to auto-generating from title.
 */
const normalizeSlug = (slug, title) => {
  const raw = sanitizeString(slug || createSlug(title), MAX_SLUG_LENGTH)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
  return raw || createSlug(title);
};

/**
 * Normalise seoKeywords or tags to a clean string array (max 20 items).
 * Accepts either a JS array or a comma-separated string (legacy clients).
 */
const normalizeStringArray = (value, itemMaxLength = 80) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeString(item, itemMaxLength))
      .filter(Boolean)
      .slice(0, 20);
  }
  if (!value) return [];
  return String(value)
    .split(',')
    .map((kw) => sanitizeString(kw, itemMaxLength))
    .filter(Boolean)
    .slice(0, 20);
};

/**
 * Normalise faqItems array.
 * Each item must have a non-empty question and answer.
 */
const normalizeFaqItems = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 10)
    .map((item) => ({
      question: sanitizeString(item?.question, 300),
      answer:   sanitizeString(item?.answer,   1000),
    }))
    .filter((item) => item.question && item.answer);
};

const normalizeStatus = (value) =>
  value === 'Draft' ? 'Draft' : 'Published';

const isMongoId = (value) =>
  /^[0-9a-fA-F]{24}$/.test(String(value ?? ''));

/**
 * Escape special regex characters to prevent ReDoS attacks.
 * Only used for category/search fields that need partial matching
 * when full-text index is not applicable.
 */
const escapeRegex = (value) =>
  String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── Payload builders ─────────────────────────────────────────────────────────

/**
 * Build a full replacement payload (used by POST and PUT).
 * Every field is explicitly sanitised — no raw body values reach the DB.
 */
const buildPayload = (body = {}) => {
  const title = sanitizeString(body.title, MAX_TITLE_LENGTH);
  const slug  = normalizeSlug(body.slug, title);

  return {
    title,
    slug,
    excerpt:         sanitizeString(body.excerpt,         MAX_EXCERPT_LENGTH),
    content:         sanitizeContent(body.content),
    metaTitle:       sanitizeString(body.metaTitle,       MAX_META_TITLE_LENGTH),
    metaDescription: sanitizeString(body.metaDescription, MAX_META_DESC_LENGTH),
    canonicalUrl:    sanitizeUrl(body.canonicalUrl,       MAX_CANONICAL_LENGTH),
    noIndex:         body.noIndex === true || body.noIndex === 'true',
    coverImage:      sanitizeUrl(body.coverImage,         MAX_COVER_IMAGE_LENGTH),
    coverImageAlt:   sanitizeString(body.coverImageAlt,   MAX_COVER_ALT_LENGTH),
    ogImage:         sanitizeUrl(body.ogImage,            MAX_OG_IMAGE_LENGTH),
    category:        sanitizeString(body.category,        MAX_CATEGORY_LENGTH) || 'Exam Updates',
    tags:            normalizeStringArray(body.tags,      60),
    seoKeywords:     normalizeStringArray(body.seoKeywords, 80),
    author:          sanitizeString(body.author,          MAX_AUTHOR_LENGTH)   || 'EduFill Experts',
    authorBio:       sanitizeString(body.authorBio,       MAX_AUTHOR_BIO_LENGTH),
    authorUrl:       sanitizeUrl(body.authorUrl,          MAX_AUTHOR_URL_LENGTH),
    faqItems:        normalizeFaqItems(body.faqItems),
    status:          normalizeStatus(body.status),
  };
};

/**
 * Build a partial update payload (used by PATCH).
 * Only includes keys the client actually sent — undefined keys are ignored.
 */
const buildPatchPayload = (body = {}) => {
  const allowed = {};

  if (body.title !== undefined)
    allowed.title = sanitizeString(body.title, MAX_TITLE_LENGTH);

  if (body.slug !== undefined)
    allowed.slug = normalizeSlug(body.slug, body.title || '');

  if (body.excerpt !== undefined)
    allowed.excerpt = sanitizeString(body.excerpt, MAX_EXCERPT_LENGTH);

  if (body.content !== undefined)
    allowed.content = sanitizeContent(body.content);

  if (body.metaTitle !== undefined)
    allowed.metaTitle = sanitizeString(body.metaTitle, MAX_META_TITLE_LENGTH);

  if (body.metaDescription !== undefined)
    allowed.metaDescription = sanitizeString(body.metaDescription, MAX_META_DESC_LENGTH);

  if (body.canonicalUrl !== undefined)
    allowed.canonicalUrl = sanitizeUrl(body.canonicalUrl, MAX_CANONICAL_LENGTH);

  if (body.noIndex !== undefined)
    allowed.noIndex = body.noIndex === true || body.noIndex === 'true';

  if (body.coverImage !== undefined)
    allowed.coverImage = sanitizeUrl(body.coverImage, MAX_COVER_IMAGE_LENGTH);

  if (body.coverImageAlt !== undefined)
    allowed.coverImageAlt = sanitizeString(body.coverImageAlt, MAX_COVER_ALT_LENGTH);

  if (body.ogImage !== undefined)
    allowed.ogImage = sanitizeUrl(body.ogImage, MAX_OG_IMAGE_LENGTH);

  if (body.category !== undefined)
    allowed.category = sanitizeString(body.category, MAX_CATEGORY_LENGTH) || 'Exam Updates';

  if (body.tags !== undefined)
    allowed.tags = normalizeStringArray(body.tags, 60);

  if (body.seoKeywords !== undefined)
    allowed.seoKeywords = normalizeStringArray(body.seoKeywords, 80);

  if (body.author !== undefined)
    allowed.author = sanitizeString(body.author, MAX_AUTHOR_LENGTH) || 'EduFill Experts';

  if (body.authorBio !== undefined)
    allowed.authorBio = sanitizeString(body.authorBio, MAX_AUTHOR_BIO_LENGTH);

  if (body.authorUrl !== undefined)
    allowed.authorUrl = sanitizeUrl(body.authorUrl, MAX_AUTHOR_URL_LENGTH);

  if (body.faqItems !== undefined)
    allowed.faqItems = normalizeFaqItems(body.faqItems);

  if (body.status !== undefined)
    allowed.status = normalizeStatus(body.status);

  return allowed;
};

// ─── Query helpers ────────────────────────────────────────────────────────────

/**
 * Return a Mongoose query filter to find one blog by MongoDB _id or slug.
 */
const findBlogQuery = (idOrSlug) => {
  const clean = sanitizeString(idOrSlug, MAX_SLUG_LENGTH);
  if (isMongoId(clean)) return { _id: clean };
  return { slug: clean.toLowerCase() };
};

/**
 * Build the public listing filter.
 * Uses MongoDB $text index for search (safe, fast, no ReDoS risk).
 */
const buildPublicListFilter = (query = {}) => {
  const filter = { status: 'Published' };

  const category = sanitizeString(query.category, MAX_CATEGORY_LENGTH);
  if (category && category !== 'All') {
    filter.category = category;
  }

  const search = sanitizeString(query.search, 100);
  if (search) {
    // $text uses the compound text index — no regex, no ReDoS
    filter.$text = { $search: search };
  }

  // Tag filter (exact match, useful for related posts / tag pages)
  const tag = sanitizeString(query.tag, 60);
  if (tag) {
    filter.tags = tag;
  }

  return filter;
};

// ─── Admin auth middleware ────────────────────────────────────────────────────

/**
 * Extract the Bearer token from the Authorization header.
 */
const getBearerToken = (req) => {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
};

/**
 * Middleware: verify admin token using constant-time comparison.
 * Prevents timing oracle attacks that could reveal the token length.
 *
 * Security notes:
 *   - Uses crypto.timingSafeEqual — safe against timing side-channels
 *   - Returns identical 401 JSON for both missing-token and wrong-token
 *     to prevent information leakage about which case was hit
 *   - Token must be set via environment variable; missing config returns 500
 */
const verifyBlogAdmin = (req, res, next) => {
  const expectedToken = String(
    process.env.ADMIN_PANEL_TOKEN || process.env.BLOG_ADMIN_TOKEN || ''
  ).trim();

  if (!expectedToken) {
    // Config error — do not expose detail to client
    console.error('SECURITY: BLOG_ADMIN_TOKEN / ADMIN_PANEL_TOKEN is not set.');
    return res.status(500).json({
      success: false,
      message: 'Server configuration error.',
    });
  }

  const receivedToken = getBearerToken(req);

  // Always run timingSafeEqual even when token is empty to avoid
  // a fast-reject timing difference that reveals token absence.
  const expected = Buffer.from(expectedToken);
  const received = Buffer.alloc(expected.length);  // pad to same length first
  Buffer.from(receivedToken).copy(received);

  const lengthMatch = expectedToken.length === receivedToken.length;
  const valueMatch  = crypto.timingSafeEqual(expected, received);

  if (!lengthMatch || !valueMatch) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized.',
    });
  }

  next();
};

// ─── Validation ───────────────────────────────────────────────────────────────

const validateRequiredBlogFields = (payload) => {
  if (!payload.title)   return 'Title is required.';
  if (!payload.slug)    return 'Slug is required.';
  if (!payload.excerpt) return 'Excerpt is required.';
  if (!payload.content) return 'Content is required.';
  return '';
};

/**
 * Check whether a slug is already taken by a different post.
 * Returns true  → duplicate exists on a different document
 * Returns false → safe to use
 */
const checkDuplicateSlug = async ({ slug, currentIdOrSlug = '' }) => {
  const existing = await Blog.findOne({ slug })
    .select('_id slug')
    .lean();

  if (!existing) return false;

  const current = sanitizeString(currentIdOrSlug, MAX_SLUG_LENGTH);
  if (!current) return true;

  if (isMongoId(current)) return String(existing._id) !== current;
  return existing.slug !== current.toLowerCase();
};

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/blogs/sitemap.xml
 *
 * Returns an XML sitemap of all published blog posts.
 * Must be registered BEFORE /:idOrSlug so Express doesn't
 * treat the literal string "sitemap.xml" as a slug.
 *
 * SEO impact: Without a sitemap, Google may never crawl new posts.
 *             With one, new posts are typically indexed within 24–48 hours.
 * Caching:    1-hour Cache-Control so CDN/proxies serve it cheaply.
 *             Invalidate on post publish if you have a CDN purge hook.
 */
router.get('/sitemap.xml', async (req, res) => {
  try {
    const blogs = await Blog.find({ status: 'Published' })
      .select('slug updatedAt publishedAt createdAt')
      .sort({ publishedAt: -1 })
      .lean();

    const BASE_URL = String(
      process.env.SITE_URL || 'https://edufills.com'
    ).replace(/\/$/, '');

    // Escape special XML characters in URLs (belt-and-suspenders)
    const xmlEscape = (str) =>
      String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const urls = blogs
      .map((b) => {
        const lastmod = (b.updatedAt || b.publishedAt || b.createdAt || new Date())
          .toISOString()
          .split('T')[0];
        return `  <url>
    <loc>${xmlEscape(`${BASE_URL}/blog/${b.slug}`)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
      })
      .join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('X-Robots-Tag', 'noindex');  // don't index the sitemap itself
    return res.status(200).send(xml);
  } catch (error) {
    console.error('GET /api/blogs/sitemap.xml error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to generate sitemap.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/blogs/meta
 *
 * Returns total published post count and per-category counts.
 * Used to populate the category filter UI without a full listing fetch.
 */
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

    return res.status(200).json({ success: true, total, categoryCounts });
  } catch (error) {
    console.error('GET /api/blogs/meta error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch blog meta.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/blogs/admin
 *
 * Returns all posts (any status) for the admin panel.
 * Protected — requires valid admin token.
 */
router.get('/admin', verifyBlogAdmin, async (req, res) => {
  try {
    const blogs = await Blog.find({})
      .select(
        'title slug excerpt coverImage coverImageAlt ogImage category tags ' +
        'seoKeywords metaTitle metaDescription canonicalUrl noIndex ' +
        'author authorBio authorUrl faqItems status publishedAt ' +
        'createdAt updatedAt'
      )
      .sort({ updatedAt: -1, _id: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      blogs,
      data: blogs,
      total: blogs.length,
    });
  } catch (error) {
    console.error('GET /api/blogs/admin error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch admin blogs.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/blogs/preview/:idOrSlug
 *
 * Returns a single post regardless of status (Draft or Published).
 * Protected — for admin/editor draft preview only.
 *
 * SEO safety: This route requires admin auth, so Googlebot never hits it.
 *             No risk of indexing draft content.
 */
router.get('/preview/:idOrSlug', verifyBlogAdmin, async (req, res) => {
  try {
    const blog = await Blog.findOne(findBlogQuery(req.params.idOrSlug)).lean();

    if (!blog) {
      return res.status(404).json({ success: false, message: 'Blog not found.' });
    }

    return res.status(200).json({ success: true, blog, data: blog });
  } catch (error) {
    console.error('GET /api/blogs/preview/:idOrSlug error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch blog preview.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/blogs/
 *
 * Paginated public listing of published posts.
 * Supports: ?page, ?limit, ?category, ?search, ?tag
 *
 * SEO note: This endpoint feeds the /blog listing page.
 *           The frontend must add self-referencing canonical + pagination
 *           <link rel="prev/next"> tags.
 */
router.get('/', async (req, res) => {
  try {
    const page  = Math.max(1, Number.parseInt(req.query.page  || '1',  10));
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit || '12', 10)));
    const skip  = (page - 1) * limit;

    const filter = buildPublicListFilter(req.query);
    const hasTextSearch = Boolean(req.query.search?.trim());

    // When text search is active, sort by relevance score first.
    const sort = hasTextSearch
      ? { score: { $meta: 'textScore' }, createdAt: -1, _id: -1 }
      : { publishedAt: -1, createdAt: -1, _id: -1 };

    // Projection: add textScore field only when doing text search
    const projection = hasTextSearch
      ? `${BLOG_LIST_FIELDS} score`
      : BLOG_LIST_FIELDS;

    const query = Blog.find(filter).select(projection).sort(sort).skip(skip).limit(limit);
    if (hasTextSearch) query.select({ score: { $meta: 'textScore' } });

    const [blogs, total] = await Promise.all([
      query.lean(),
      Blog.countDocuments(filter),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    // Expose pagination info in headers for programmatic clients
    res.setHeader('X-Total-Count', String(total));
    res.setHeader('X-Total-Pages', String(totalPages));

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
    return res.status(500).json({ success: false, message: 'Failed to fetch blogs.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/blogs/
 *
 * Create a new blog post.
 * Protected — requires valid admin token.
 */
router.post('/', verifyBlogAdmin, async (req, res) => {
  try {
    const payload = buildPayload(req.body);

    const validationError = validateRequiredBlogFields(payload);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const duplicate = await Blog.findOne({ slug: payload.slug }).select('_id').lean();
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'A post with this slug already exists. Please choose a different slug.',
      });
    }

    const blog = await Blog.create(payload);

    return res.status(201).json({
      success: true,
      message: 'Blog post created successfully.',
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('POST /api/blogs error:', error.message);
    // Don't leak Mongoose internals — generic message to client
    return res.status(500).json({ success: false, message: 'Failed to create blog post.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/blogs/:idOrSlug
 *
 * Returns a single PUBLISHED post by MongoDB _id or slug.
 * Draft posts return 404 — clients must use /preview/:idOrSlug instead.
 *
 * SEO: The response includes all fields needed to build Article, FAQ,
 *      Author, and BreadcrumbList JSON-LD on the frontend.
 */
router.get('/:idOrSlug', async (req, res) => {
  try {
    const query = {
      ...findBlogQuery(req.params.idOrSlug),
      status: 'Published',
    };

    const blog = await Blog.findOne(query).lean();

    if (!blog) {
      return res.status(404).json({ success: false, message: 'Blog post not found.' });
    }

    return res.status(200).json({
      success: true,
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('GET /api/blogs/:idOrSlug error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch blog post.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUT /api/blogs/:idOrSlug
 *
 * Full replacement update.
 * Protected — requires valid admin token.
 */
router.put('/:idOrSlug', verifyBlogAdmin, async (req, res) => {
  try {
    const payload = buildPayload(req.body);

    const validationError = validateRequiredBlogFields(payload);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const isDuplicate = await checkDuplicateSlug({
      slug: payload.slug,
      currentIdOrSlug: req.params.idOrSlug,
    });
    if (isDuplicate) {
      return res.status(409).json({
        success: false,
        message: 'This slug is already used by another post.',
      });
    }

    const blog = await Blog.findOneAndUpdate(
      findBlogQuery(req.params.idOrSlug),
      payload,
      { new: true, runValidators: true }
    );

    if (!blog) {
      return res.status(404).json({ success: false, message: 'Blog post not found.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Blog post updated successfully.',
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('PUT /api/blogs/:idOrSlug error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to update blog post.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/blogs/:idOrSlug
 *
 * Partial update — only fields present in the request body are changed.
 * Protected — requires valid admin token.
 */
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
          message: 'This slug is already used by another post.',
        });
      }
    }

    const blog = await Blog.findOneAndUpdate(
      findBlogQuery(req.params.idOrSlug),
      allowed,
      { new: true, runValidators: true }
    );

    if (!blog) {
      return res.status(404).json({ success: false, message: 'Blog post not found.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Blog post updated successfully.',
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('PATCH /api/blogs/:idOrSlug error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to update blog post.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/blogs/:idOrSlug/status
 *
 * Toggle a post between Draft and Published.
 * publishedAt is auto-set by the model's pre-findOneAndUpdate hook
 * when status transitions to Published.
 * Protected — requires valid admin token.
 */
router.patch('/:idOrSlug/status', verifyBlogAdmin, async (req, res) => {
  try {
    const status = normalizeStatus(req.body.status);

    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status value.' });
    }

    const blog = await Blog.findOneAndUpdate(
      findBlogQuery(req.params.idOrSlug),
      { status },
      { new: true, runValidators: true }
    );

    if (!blog) {
      return res.status(404).json({ success: false, message: 'Blog post not found.' });
    }

    return res.status(200).json({
      success: true,
      message: `Blog post moved to ${status}.`,
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('PATCH /api/blogs/:idOrSlug/status error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to update blog status.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * DELETE /api/blogs/:idOrSlug
 *
 * Permanently delete a post.
 * Protected — requires valid admin token.
 *
 * SEO note: After deletion, your frontend/server should return a 410 Gone
 *           (not 404) for the slug so Google removes it from the index faster.
 *           Consider keeping a 'deleted slugs' collection for this purpose.
 */
router.delete('/:idOrSlug', verifyBlogAdmin, async (req, res) => {
  try {
    const blog = await Blog.findOneAndDelete(findBlogQuery(req.params.idOrSlug));

    if (!blog) {
      return res.status(404).json({ success: false, message: 'Blog post not found.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Blog post deleted successfully.',
      blog,
      data: blog,
    });
  } catch (error) {
    console.error('DELETE /api/blogs/:idOrSlug error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to delete blog post.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

module.exports = router;