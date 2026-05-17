const express = require('express');
const router = express.Router();
const Exam = require('../models/Exam');

const isMongoId = (value) => /^[0-9a-fA-F]{24}$/.test(String(value || ''));

const slugify = (value = '') =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');

const cleanDate = (value) => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const buildPayload = (body = {}) => {
  const title = String(body.title || '').trim();
  const slug = String(body.slug || slugify(title)).trim().toLowerCase();

  return {
    title,
    department: String(body.department || '').trim(),

    category: Array.isArray(body.category)
      ? body.category.join(', ')
      : body.category || 'Government',

    shortInfo: body.shortInfo || '',
    notificationNumber: body.notificationNumber || '',

    postDate: cleanDate(body.postDate),
    startDate: cleanDate(body.startDate),
    lastDate: cleanDate(body.lastDate),
    payFeeLastDate: cleanDate(body.payFeeLastDate),

    examDate: body.examDate || '',
    admitCardDate: body.admitCardDate || '',

    applicationFee: body.applicationFee || '',
    paymentMode: body.paymentMode || '',
    ageLimit: body.ageLimit || '',
    totalVacancies: body.totalVacancies || '',
    qualification: body.qualification || '',
    howToApply: body.howToApply || '',
    importantInstructions: body.importantInstructions || '',

    officialLink: body.officialLink || '',
    applyOnlineLink: body.applyOnlineLink || '',
    notificationLink: body.notificationLink || '',
    syllabusLink: body.syllabusLink || '',
    officialWebsite: body.officialWebsite || '',

    seoTitle: body.seoTitle || title,
    metaDescription: body.metaDescription || body.shortInfo || '',
    keywords: body.keywords || '',
    slug,

    ogImage: body.ogImage || '',
    canonicalUrl: body.canonicalUrl || '',
    robots: body.robots || 'index, follow',

    status: body.status === 'Expired' ? 'Expired' : 'Active',
  };
};

const getUniqueSlug = async (baseSlug, excludeId = null) => {
  let slug = baseSlug || `exam-${Date.now()}`;
  let counter = 2;

  while (true) {
    const query = { slug };

    if (excludeId) {
      query._id = { $ne: excludeId };
    }

    const exists = await Exam.findOne(query).select('_id').lean();

    if (!exists) return slug;

    slug = `${baseSlug}-${counter}`;
    counter += 1;
  }
};

const findExamByIdOrSlug = async (idOrSlug) => {
  const value = String(idOrSlug || '').trim();

  if (!value) return null;

  if (isMongoId(value)) {
    return Exam.findById(value).lean();
  }

  const normalizedSlug = value.toLowerCase();

  let exam = await Exam.findOne({ slug: normalizedSlug }).lean();

  if (exam) return exam;

  // Fallback for old exams where slug field was not saved.
  // If frontend sends slug made from title, this can still find old records.
  const allExams = await Exam.find({}).select('title slug').lean();

  const matched = allExams.find((item) => {
    return slugify(item.title) === normalizedSlug;
  });

  if (!matched) return null;

  return Exam.findById(matched._id).lean();
};

// Admin page: direct array return
router.get('/admin', async (req, res) => {
  try {
    const exams = await Exam.find({})
      .sort({ createdAt: -1, lastDate: -1 })
      .lean();

    return res.json(exams);
  } catch (error) {
    console.error('GET /api/exams/admin error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch exams.',
    });
  }
});

// Public exams page: direct array return
router.get('/', async (req, res) => {
  try {
    const includeAll =
      req.query.admin === 'true' ||
      req.query.includeExpired === 'true';

    const filter = includeAll
      ? {}
      : {
          status: { $ne: 'Expired' },
        };

    if (req.query.category && req.query.category !== 'All') {
      filter.category = {
        $regex: String(req.query.category),
        $options: 'i',
      };
    }

    if (req.query.search) {
      const search = String(req.query.search).trim();

      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { title: { $regex: search, $options: 'i' } },
            { department: { $regex: search, $options: 'i' } },
            { category: { $regex: search, $options: 'i' } },
            { keywords: { $regex: search, $options: 'i' } },
            { shortInfo: { $regex: search, $options: 'i' } },
          ],
        },
      ];
    }

    const exams = await Exam.find(filter)
      .sort({ lastDate: -1, createdAt: -1 })
      .lean();

    return res.json(exams);
  } catch (error) {
    console.error('GET /api/exams error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch exams.',
    });
  }
});

// Create exam
router.post('/', async (req, res) => {
  try {
    const payload = buildPayload(req.body);

    if (!payload.title || !payload.department) {
      return res.status(400).json({
        success: false,
        message: 'Title and department are required.',
      });
    }

    payload.slug = await getUniqueSlug(payload.slug || slugify(payload.title));

    const exam = await Exam.create(payload);

    return res.status(201).json({
      success: true,
      exam,
    });
  } catch (error) {
    console.error('POST /api/exams error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create exam.',
    });
  }
});

// Get single exam by MongoDB ID or slug
router.get('/:idOrSlug', async (req, res) => {
  try {
    const exam = await findExamByIdOrSlug(req.params.idOrSlug);

    if (!exam) {
      return res.status(404).json({
        success: false,
        message: 'Exam not found.',
      });
    }

    return res.json(exam);
  } catch (error) {
    console.error('GET /api/exams/:idOrSlug error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch exam.',
    });
  }
});

// Update exam by MongoDB ID or slug
router.put('/:idOrSlug', async (req, res) => {
  try {
    const current = await findExamByIdOrSlug(req.params.idOrSlug);

    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'Exam not found.',
      });
    }

    const payload = buildPayload(req.body);

    if (!payload.title || !payload.department) {
      return res.status(400).json({
        success: false,
        message: 'Title and department are required.',
      });
    }

    payload.slug = await getUniqueSlug(
      payload.slug || slugify(payload.title),
      current._id
    );

    const exam = await Exam.findByIdAndUpdate(current._id, payload, {
      returnDocument: 'after',
      runValidators: true,
    });

    return res.json({
      success: true,
      exam,
    });
  } catch (error) {
    console.error('PUT /api/exams/:idOrSlug error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update exam.',
    });
  }
});

// Delete exam by MongoDB ID or slug
router.delete('/:idOrSlug', async (req, res) => {
  try {
    const current = await findExamByIdOrSlug(req.params.idOrSlug);

    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'Exam not found.',
      });
    }

    await Exam.findByIdAndDelete(current._id);

    return res.json({
      success: true,
      message: 'Exam deleted successfully.',
    });
  } catch (error) {
    console.error('DELETE /api/exams/:idOrSlug error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete exam.',
    });
  }
});

module.exports = router;