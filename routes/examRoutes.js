const express = require('express');
const crypto = require('crypto');

const router = express.Router();
const Exam = require('../models/Exam');

const MAX_TEXT = 1000;
const MAX_LONG_TEXT = 8000;
const MAX_URL = 1200;
const MAX_SLUG = 220;

const isMongoId = (value) => /^[0-9a-fA-F]{24}$/.test(String(value || ''));

const sanitizeText = (value, maxLength = MAX_TEXT) => {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
};

const escapeRegex = (value) => {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const slugify = (value = '') =>
  sanitizeText(value, MAX_SLUG)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');

const cleanDate = (value) => {
  if (!value) return undefined;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date;
};

const cleanUrl = (value) => {
  const url = sanitizeText(value, MAX_URL);

  if (!url) return '';

  return url;
};

const normalizeCategory = (category) => {
  if (Array.isArray(category)) {
    return category
      .map((item) => sanitizeText(item, 80))
      .filter(Boolean)
      .join(', ');
  }

  return sanitizeText(category, 200) || 'Government';
};

const normalizeStatus = (status) => {
  return status === 'Expired' ? 'Expired' : 'Active';
};

const normalizeRobots = (robots) => {
  return robots === 'noindex, nofollow' ? 'noindex, nofollow' : 'index, follow';
};

const buildPayload = (body = {}) => {
  const title = sanitizeText(body.title, 220);
  const slug = slugify(body.slug || title);

  return {
    title,
    department: sanitizeText(body.department, 160),

    category: normalizeCategory(body.category),

    shortInfo: sanitizeText(body.shortInfo, MAX_LONG_TEXT),
    notificationNumber: sanitizeText(body.notificationNumber, 120),

    postDate: cleanDate(body.postDate),
    startDate: cleanDate(body.startDate),
    lastDate: cleanDate(body.lastDate),
    payFeeLastDate: cleanDate(body.payFeeLastDate),

    examDate: sanitizeText(body.examDate, 160),
    admitCardDate: sanitizeText(body.admitCardDate, 160),

    applicationFee: sanitizeText(body.applicationFee, MAX_LONG_TEXT),
    paymentMode: sanitizeText(body.paymentMode, 500),
    ageLimit: sanitizeText(body.ageLimit, MAX_LONG_TEXT),
    totalVacancies: sanitizeText(body.totalVacancies, MAX_LONG_TEXT),
    qualification: sanitizeText(body.qualification, MAX_LONG_TEXT),
    howToApply: sanitizeText(body.howToApply, MAX_LONG_TEXT),
    importantInstructions: sanitizeText(body.importantInstructions, MAX_LONG_TEXT),

    officialLink: cleanUrl(body.officialLink),
    applyOnlineLink: cleanUrl(body.applyOnlineLink),
    notificationLink: cleanUrl(body.notificationLink),
    syllabusLink: cleanUrl(body.syllabusLink),
    officialWebsite: cleanUrl(body.officialWebsite),

    seoTitle: sanitizeText(body.seoTitle || title, 180),
    metaDescription: sanitizeText(body.metaDescription || body.shortInfo, 320),
    keywords: sanitizeText(body.keywords, 800),
    slug,

    ogImage: cleanUrl(body.ogImage),
    canonicalUrl: cleanUrl(body.canonicalUrl),
    robots: normalizeRobots(body.robots),

    status: normalizeStatus(body.status),
  };
};

const validatePayload = (payload) => {
  if (!payload.title) return 'Title is required.';
  if (!payload.department) return 'Department is required.';
  if (!payload.slug) return 'Slug is required.';

  return '';
};

const getBearerToken = (req) => {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    return '';
  }

  return header.replace('Bearer ', '').trim();
};

const verifyAdmin = (req, res, next) => {
  const expectedToken = String(
    process.env.ADMIN_PANEL_TOKEN || process.env.BLOG_ADMIN_TOKEN || ''
  ).trim();

  if (!expectedToken) {
    return res.status(500).json({
      success: false,
      message: 'Admin token is not configured on server.',
    });
  }

  const receivedToken = getBearerToken(req).trim();

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

const getUniqueSlug = async (baseSlug, excludeId = null) => {
  const fallbackSlug = baseSlug || `exam-${Date.now()}`;
  let slug = fallbackSlug;
  let counter = 2;

  while (true) {
    const query = { slug };

    if (excludeId) {
      query._id = { $ne: excludeId };
    }

    const exists = await Exam.findOne(query).select('_id').lean();

    if (!exists) return slug;

    slug = `${fallbackSlug}-${counter}`;
    counter += 1;
  }
};

const findExamByIdOrSlug = async (idOrSlug, options = {}) => {
  const { includeExpired = false } = options;

  const value = sanitizeText(idOrSlug, MAX_SLUG);

  if (!value) return null;

  const baseFilter = includeExpired ? {} : { status: { $ne: 'Expired' } };

  if (isMongoId(value)) {
    return Exam.findOne({
      _id: value,
      ...baseFilter,
    }).lean();
  }

  const normalizedSlug = value.toLowerCase();

  let exam = await Exam.findOne({
    slug: normalizedSlug,
    ...baseFilter,
  }).lean();

  if (exam) return exam;

  const allExams = await Exam.find(baseFilter).select('title slug').lean();

  const matched = allExams.find((item) => {
    return slugify(item.title) === normalizedSlug;
  });

  if (!matched) return null;

  return Exam.findOne({
    _id: matched._id,
    ...baseFilter,
  }).lean();
};

router.get('/admin', verifyAdmin, async (req, res) => {
  try {
    const exams = await Exam.find({})
      .sort({ createdAt: -1, lastDate: -1, _id: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      exams,
      data: exams,
      total: exams.length,
    });
  } catch (error) {
    console.error('GET /api/exams/admin error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch exams.',
    });
  }
});

router.get('/', async (req, res) => {
  try {
    const filter = {
      status: { $ne: 'Expired' },
    };

    if (req.query.category && req.query.category !== 'All') {
      filter.category = {
        $regex: escapeRegex(sanitizeText(req.query.category, 80)),
        $options: 'i',
      };
    }

    if (req.query.search) {
      const search = sanitizeText(req.query.search, 80);
      const regex = new RegExp(escapeRegex(search), 'i');

      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { title: regex },
            { department: regex },
            { category: regex },
            { keywords: regex },
            { shortInfo: regex },
          ],
        },
      ];
    }

    const exams = await Exam.find(filter)
      .sort({ lastDate: -1, createdAt: -1, _id: -1 })
      .lean();

    return res.status(200).json(exams);
  } catch (error) {
    console.error('GET /api/exams error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch exams.',
    });
  }
});

router.post('/', verifyAdmin, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const validationError = validatePayload(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    payload.slug = await getUniqueSlug(payload.slug || slugify(payload.title));

    const exam = await Exam.create(payload);

    return res.status(201).json({
      success: true,
      message: 'Exam created successfully.',
      exam,
      data: exam,
    });
  } catch (error) {
    console.error('POST /api/exams error:', error.message);

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create exam.',
    });
  }
});

router.get('/:idOrSlug', async (req, res) => {
  try {
    const exam = await findExamByIdOrSlug(req.params.idOrSlug, {
      includeExpired: false,
    });

    if (!exam) {
      return res.status(404).json({
        success: false,
        message: 'Exam not found.',
      });
    }

    return res.status(200).json({
      success: true,
      exam,
      data: exam,
      ...exam,
    });
  } catch (error) {
    console.error('GET /api/exams/:idOrSlug error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch exam.',
    });
  }
});

router.put('/:idOrSlug', verifyAdmin, async (req, res) => {
  try {
    const current = await findExamByIdOrSlug(req.params.idOrSlug, {
      includeExpired: true,
    });

    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'Exam not found.',
      });
    }

    const payload = buildPayload(req.body);
    const validationError = validatePayload(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    payload.slug = await getUniqueSlug(
      payload.slug || slugify(payload.title),
      current._id
    );

    const exam = await Exam.findByIdAndUpdate(current._id, payload, {
      new: true,
      runValidators: true,
    });

    return res.status(200).json({
      success: true,
      message: 'Exam updated successfully.',
      exam,
      data: exam,
    });
  } catch (error) {
    console.error('PUT /api/exams/:idOrSlug error:', error.message);

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update exam.',
    });
  }
});

router.delete('/:idOrSlug', verifyAdmin, async (req, res) => {
  try {
    const current = await findExamByIdOrSlug(req.params.idOrSlug, {
      includeExpired: true,
    });

    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'Exam not found.',
      });
    }

    await Exam.findByIdAndDelete(current._id);

    return res.status(200).json({
      success: true,
      message: 'Exam deleted successfully.',
    });
  } catch (error) {
    console.error('DELETE /api/exams/:idOrSlug error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to delete exam.',
    });
  }
});

module.exports = router;