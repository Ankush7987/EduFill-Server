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
  return sanitizeText(value, MAX_URL);
};

const normalizeCategory = (category) => {
  if (Array.isArray(category)) {
    return category.map((item) => sanitizeText(item, 80)).filter(Boolean).join(', ');
  }
  return sanitizeText(category, 200) || 'Government';
};

// 🔥 AUTO GENERATE GOOGLE COMPLIANT SCHEMA.ORG JSON-LD STRUCTURED DATA
const generateGoogleSchema = (payload) => {
  const domain = process.env.FRONTEND_URL || 'https://edufill.in';
  return {
    "@context": "https://schema.org",
    "@type": "EducationEvent",
    "name": payload.title,
    "description": payload.metaDescription || payload.shortInfo.slice(0, 200),
    "organizer": {
      "@type": "Organization",
      "name": payload.department || "Government",
      "url": payload.officialWebsite || domain
    },
    "eventStatus": payload.status === 'Active' ? "https://schema.org/EventScheduled" : "https://schema.org/EventCancelled",
    "offers": {
      "@type": "Offer",
      "price": "0", // Default to free info, alter if numerical pricing available
      "priceCurrency": "INR",
      "url": `${domain}/exams/${payload.slug}`
    },
    "startDate": payload.startDate || payload.postDate || new Date(),
    "endDate": payload.lastDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  };
};

const buildPayload = (body = {}) => {
  const title = sanitizeText(body.title, 220);
  const slug = slugify(body.slug || title);
  
  // High accuracy SEO word counts enforcement
  const rawShortInfo = sanitizeText(body.shortInfo, MAX_LONG_TEXT);
  const optimizedSeoTitle = sanitizeText(body.seoTitle || `${title} Recruitment 2026 | Apply Online`, 60);
  const optimizedMetaDesc = sanitizeText(body.metaDescription || rawShortInfo || `${title} notification details, eligibility, criteria, and direct link to apply online.`, 160);

  const domain = process.env.FRONTEND_URL || 'https://edufill.in';

  const basePayload = {
    title,
    department: sanitizeText(body.department, 160),
    category: normalizeCategory(body.category),
    shortInfo: rawShortInfo,
    notificationNumber: sanitizeText(body.notificationNumber, 120),
    postDate: cleanDate(body.postDate) || new Date(),
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
    
    // SEO Fields Optimized
    seoTitle: optimizedSeoTitle,
    metaDescription: optimizedMetaDesc,
    keywords: sanitizeText(body.keywords || `${title}, recruitment, online form, exam date`, 800),
    slug,
    ogImage: cleanUrl(body.ogImage) || `${domain}/default-og-image.jpg`,
    canonicalUrl: cleanUrl(body.canonicalUrl) || `${domain}/exams/${slug}`,
    robots: body.robots === 'noindex, nofollow' ? 'noindex, nofollow' : 'index, follow',
    status: body.status === 'Expired' ? 'Expired' : 'Active',
  };

  // Inject structured data directly into database payload
  basePayload.structuredData = generateGoogleSchema(basePayload);
  return basePayload;
};

const validatePayload = (payload) => {
  if (!payload.title) return 'Title is required.';
  if (!payload.department) return 'Department is required.';
  if (!payload.slug) return 'Slug is required.';
  return '';
};

const verifyAdmin = (req, res, next) => {
  const expectedToken = String(process.env.ADMIN_PANEL_TOKEN || process.env.BLOG_ADMIN_TOKEN || '').trim();
  if (!expectedToken) return res.status(500).json({ success: false, message: 'Admin token missing.' });
  
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Admin token required.' });
  
  const receivedToken = header.replace('Bearer ', '').trim();
  const expectedBuffer = Buffer.from(expectedToken);
  const receivedBuffer = Buffer.from(receivedToken);

  if (expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }
  next();
};

const getUniqueSlug = async (baseSlug, excludeId = null) => {
  const fallbackSlug = baseSlug || `exam-${Date.now()}`;
  let slug = fallbackSlug;
  let counter = 2;
  while (true) {
    const query = { slug };
    if (excludeId) query._id = { $ne: excludeId };
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
  if (isMongoId(value)) return Exam.findOne({ _id: value, ...baseFilter }).lean();

  const normalizedSlug = value.toLowerCase();
  let exam = await Exam.findOne({ slug: normalizedSlug, ...baseFilter }).lean();
  if (exam) return exam;

  const allExams = await Exam.find(baseFilter).select('title slug').lean();
  const matched = allExams.find((item) => slugify(item.title) === normalizedSlug);
  if (!matched) return null;

  return Exam.findOne({ _id: matched._id, ...baseFilter }).lean();
};

// 🔥 100% SEO EXCLUSION: LIVE SITEMAP SYNC FEED FOR GOOGLE CRAWLER
router.get('/seo-sitemap-feed', async (req, res) => {
  try {
    const activeExams = await Exam.find({ status: 'Active' })
      .select('slug updatedAt canonicalUrl robots')
      .sort({ updatedAt: -1 })
      .lean();
    
    return res.status(200).json({
      success: true,
      count: activeExams.length,
      urls: activeExams.map(e => ({
        loc: e.canonicalUrl || `https://edufill.in/exams/${e.slug}`,
        lastmod: e.updatedAt,
        changefreq: 'daily',
        priority: 0.9,
        robots: e.robots
      }))
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/admin', verifyAdmin, async (req, res) => {
  try {
    const exams = await Exam.find({}).sort({ createdAt: -1, lastDate: -1, _id: -1 }).lean();
    return res.status(200).json({ success: true, exams, data: exams, total: exams.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch exams.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const filter = { status: { $ne: 'Expired' } };
    if (req.query.category && req.query.category !== 'All') {
      filter.category = { $regex: escapeRegex(sanitizeText(req.query.category, 80)), $options: 'i' };
    }
    if (req.query.search) {
      const search = sanitizeText(req.query.search, 80);
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$and = [
        ...(filter.$and || []),
        { $or: [ { title: regex }, { department: regex }, { category: regex }, { keywords: regex }, { shortInfo: regex } ] }
      ];
    }

    const exams = await Exam.find(filter).sort({ lastDate: -1, createdAt: -1, _id: -1 }).lean();
    return res.status(200).json(exams);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch exams.' });
  }
});

router.post('/', verifyAdmin, async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    const validationError = validatePayload(payload);
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    payload.slug = await getUniqueSlug(payload.slug || slugify(payload.title));
    const exam = await Exam.create(payload);

    return res.status(201).json({ success: true, message: 'Exam created successfully.', exam, data: exam });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:idOrSlug', async (req, res) => {
  try {
    const exam = await findExamByIdOrSlug(req.params.idOrSlug, { includeExpired: false });
    if (!exam) return res.status(404).json({ success: false, message: 'Exam not found.' });

    // Client directly destructured output me JSON-LD Structured script inject kar payega
    return res.status(200).json({ success: true, exam, data: exam, ...exam });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch exam.' });
  }
});

router.put('/:idOrSlug', verifyAdmin, async (req, res) => {
  try {
    const current = await findExamByIdOrSlug(req.params.idOrSlug, { includeExpired: true });
    if (!current) return res.status(404).json({ success: false, message: 'Exam not found.' });

    const payload = buildPayload(req.body);
    const validationError = validatePayload(payload);
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    payload.slug = await getUniqueSlug(payload.slug || slugify(payload.title), current._id);
    const exam = await Exam.findByIdAndUpdate(current._id, payload, { new: true, runValidators: true });

    return res.status(200).json({ success: true, message: 'Exam updated successfully.', exam, data: exam });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/:idOrSlug', verifyAdmin, async (req, res) => {
  try {
    const current = await findExamByIdOrSlug(req.params.idOrSlug, { includeExpired: true });
    if (!current) return res.status(404).json({ success: false, message: 'Exam not found.' });

    await Exam.findByIdAndDelete(current._id);
    return res.status(200).json({ success: true, message: 'Exam deleted successfully.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to delete exam.' });
  }
});

module.exports = router;