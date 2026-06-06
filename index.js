'use strict';

// ─────────────────────────────────────────────
// CORE IMPORTS
// ─────────────────────────────────────────────
const express    = require('express');
const cors       = require('cors');
const admin      = require('firebase-admin');
const mongoose   = require('mongoose');
const compression = require('compression');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const https      = require('https');
const http       = require('http');
const path       = require('path');
const { Server } = require('socket.io');
require('dotenv').config();

const Blog        = require('./models/Blog');
const LiveChat    = require('./models/LiveChat');
const LiveRequest = require('./models/LiveRequest');
const { setLiveIO }                  = require('./services/liveSocketHub');
const { startLiveOfferTimeoutJob }   = require('./jobs/liveOfferTimeoutJob');
const { startFirestoreLiveBridge }   = require('./jobs/firestoreLiveBridge');

// ─────────────────────────────────────────────
// ENVIRONMENT CONFIG
// ─────────────────────────────────────────────
const NODE_ENV    = process.env.NODE_ENV || 'development';
const IS_PROD     = NODE_ENV === 'production';
const PORT        = Number(process.env.PORT) || 5000;
const SITE_URL    = (process.env.SITE_URL || 'https://edufills.com').replace(/\/$/, '');
const SERVER_URL  = process.env.SERVER_URL || '';

const MAX_SOCKET_MESSAGE_LENGTH  = Number(process.env.MAX_SOCKET_MESSAGE_LENGTH  || 2000);
const MAX_SOCKET_HISTORY_MESSAGES = Number(process.env.MAX_SOCKET_HISTORY_MESSAGES || 200);
const INITIAL_HISTORY_SIZE        = 30; // send only last 30 msgs on join; load more on demand

// ─────────────────────────────────────────────
// IN-PROCESS TTL CACHE  (zero dependencies)
// ─────────────────────────────────────────────
class TTLCache {
  constructor(ttlMs = 60_000) {
    this.store = new Map();
    this.ttl   = ttlMs;
  }
  get(key) {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) { this.store.delete(key); return null; }
    return e.val;
  }
  set(key, val) {
    this.store.set(key, { val, exp: Date.now() + this.ttl });
    return val;
  }
  del(key) { this.store.delete(key); }
  prune() {
    const now = Date.now();
    for (const [k, v] of this.store) if (now > v.exp) this.store.delete(k);
  }
}

// Cache instances
const roomMetaCache = new TTLCache(10 * 60_000);  // 10 min — room meta almost never changes
const sitemapCache  = new TTLCache(60 * 60_000);   // 1 hr  — sitemap rarely changes

// Prune stale cache entries every 30 minutes to avoid unbounded memory growth
setInterval(() => {
  roomMetaCache.prune();
  sitemapCache.prune();
}, 30 * 60_000).unref?.();

// ─────────────────────────────────────────────
// PURE UTILITY FUNCTIONS
// ─────────────────────────────────────────────
const sanitizeString = (value, maxLength = 500) =>
  String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const normalizeOrigin = (origin) =>
  String(origin || '').trim().replace(/\/$/, '');

const splitEnvList = (value) =>
  String(value || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

const escapeXml = (value) =>
  String(value || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');

const safeDate = (value, fallback = new Date()) => {
  const d = value ? new Date(value) : fallback;
  return Number.isNaN(d.getTime())
    ? fallback.toISOString().split('T')[0]
    : d.toISOString().split('T')[0];
};

const normalizeSenderType = (value) => {
  const t = sanitizeString(value, 30).toLowerCase();
  if (['agent', 'expert', 'employee', 'staff'].includes(t)) return 'agent';
  if (['admin', 'administrator'].includes(t))                return 'admin';
  if (['system', 'bot'].includes(t))                         return 'system';
  return 'student';
};

const normalizeRoomId = (value) => sanitizeString(value, 160);

const resolveRoomId = (data = {}) =>
  normalizeRoomId(
    data.roomId          ||
    data.chatRoomId      ||
    data.requestId       ||
    data.liveRequestId   ||
    data.firebaseRequestId ||
    data.id
  );

const buildSocketMessage = (data = {}) => ({
  senderId:   sanitizeString(data.senderId   || data.userId      || data.studentId || data.agentId || data.employeeId || '', 120),
  senderName: sanitizeString(data.senderName || data.name        || data.studentName || data.agentName || '', 80),
  senderType: normalizeSenderType(data.senderType || data.senderRole || data.role || data.type),
  text:       sanitizeString(data.text || data.message || data.content || '', MAX_SOCKET_MESSAGE_LENGTH),
  timestamp:  new Date(),
});

// ─────────────────────────────────────────────
// SEO — STRUCTURED DATA & SITEMAP HELPERS
// ─────────────────────────────────────────────

/**
 * Builds the complete sitemap XML string.
 * Extracted so the route handler can call it independently and it's testable.
 */
const buildSitemapXml = (blogs) => {
  const today = new Date().toISOString().split('T')[0];

  const staticUrls = [
    { loc: '/',                    priority: '1.0', changefreq: 'daily'   },
    { loc: '/college-predictor',   priority: '0.9', changefreq: 'daily'   },
    { loc: '/mock-test',           priority: '0.9', changefreq: 'daily'   },
    { loc: '/campus-drive',        priority: '0.9', changefreq: 'weekly'  },
    { loc: '/apply/neet',          priority: '0.9', changefreq: 'weekly'  },
    { loc: '/apply/jee',           priority: '0.9', changefreq: 'weekly'  },
    { loc: '/apply/cuet',          priority: '0.9', changefreq: 'weekly'  },
    { loc: '/apply/govt-college',  priority: '0.9', changefreq: 'weekly'  },
    { loc: '/tools',               priority: '0.9', changefreq: 'weekly'  },
    { loc: '/tools/photo-date',    priority: '0.85', changefreq: 'weekly' },
    { loc: '/tools/resizer',       priority: '0.85', changefreq: 'weekly' },
    { loc: '/tools/pdf-maker',     priority: '0.85', changefreq: 'weekly' },
    { loc: '/tools/pdf-compressor',priority: '0.85', changefreq: 'weekly' },
    { loc: '/blogs',               priority: '0.9', changefreq: 'daily'   },
    { loc: '/exams',               priority: '0.9', changefreq: 'daily'   },
    { loc: '/about',               priority: '0.8', changefreq: 'monthly' },
    { loc: '/contact',             priority: '0.8', changefreq: 'monthly' },
    { loc: '/privacy-policy',      priority: '0.5', changefreq: 'yearly'  },
    { loc: '/terms-and-conditions',priority: '0.5', changefreq: 'yearly'  },
    { loc: '/refund-policy',       priority: '0.5', changefreq: 'yearly'  },
  ];

  const staticPart = staticUrls.map((link) => [
    '  <url>',
    `    <loc>${escapeXml(`${SITE_URL}${link.loc}`)}</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>${link.changefreq}</changefreq>`,
    `    <priority>${link.priority}</priority>`,
    '  </url>',
  ].join('\n')).join('\n');

  const blogPart = blogs
    .filter((b) => b.slug)
    .map((b) => [
      '  <url>',
      `    <loc>${escapeXml(`${SITE_URL}/blog/${b.slug}`)}</loc>`,
      `    <lastmod>${safeDate(b.updatedAt)}</lastmod>`,
      '    <changefreq>weekly</changefreq>',
      '    <priority>0.8</priority>',
      '  </url>',
    ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"',
    '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    staticPart,
    blogPart,
    '</urlset>',
  ].filter(Boolean).join('\n');
};

// ─────────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────────
const getFirebaseServiceAccount = () => {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      return parsed;
    }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      return require(path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS));
    }
  } catch (err) {
    console.error('Firebase credential parse error:', err.message);
  }
  return null;
};

const initFirebase = async () => {
  const serviceAccount = getFirebaseServiceAccount();
  if (!serviceAccount) {
    console.warn('Firebase: no credentials found — skipping init.');
    return null;
  }
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    const db = admin.firestore();
    // Warm-up connection without failing startup if Firestore is unreachable
    await db.collection('_health').limit(1).get().catch(() => {});
    console.log('Firebase Admin connected');
    return db;
  } catch (err) {
    console.error('Firebase init error:', err.message);
    return null; // Never crash the server over Firebase
  }
};

// ─────────────────────────────────────────────
// MONGODB
// ─────────────────────────────────────────────
const connectMongoDB = async () => {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is missing.');
    return;
  }
  mongoose.set('strictQuery', false);
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000,   // fail fast
    socketTimeoutMS:          30_000,
    connectTimeoutMS:         10_000,
    maxPoolSize:              20,     // up from 10 — handles concurrent socket queries
    minPoolSize:              5,      // keep warm connections alive between requests
    maxIdleTimeMS:            60_000,
    heartbeatFrequencyMS:     10_000,
    retryWrites:              true,
    retryReads:               true,
  });
  console.log('MongoDB Atlas connected');
};

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected — retrying in 5 s...');
  setTimeout(() => {
    if (mongoose.connection.readyState === 0) {
      connectMongoDB().catch((e) => console.error('Reconnect failed:', e.message));
    }
  }, 5000);
});

mongoose.connection.on('error', (err) => {
  console.error('MongoDB runtime error:', err.message);
});

// ─────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.disable('x-powered-by');
app.set('trust proxy', 1);

// ── Helmet (security headers + SEO-safe CSP) ──────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // Only enforce CSP in production — avoids breaking local dev
    contentSecurityPolicy: IS_PROD
      ? {
          directives: {
            defaultSrc:  ["'self'"],
            scriptSrc:   ["'self'"],
            styleSrc:    ["'self'", "'unsafe-inline'"],
            imgSrc:      ["'self'", 'data:', 'https:'],
            connectSrc:  ["'self'", 'https://*.firebaseio.com', 'wss:'],
            fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
            objectSrc:   ["'none'"],
            upgradeInsecureRequests: [],
          },
        }
      : false,
    // Let Googlebot access pages
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// ── SEO: Canonical redirect — strip trailing slashes ─────────────────────────
app.use((req, res, next) => {
  if (req.path.length > 1 && req.path.endsWith('/') && req.path !== '/') {
    const query = req.url.slice(req.path.length);
    return res.redirect(301, req.path.slice(0, -1) + query);
  }
  next();
});

// ── CORS ──────────────────────────────────────────────────────────────────────
const defaultAllowedOrigins = [
  'https://edufills.com',
  'https://www.edufills.com',
  'https://aapki-website.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const allowedOrigins = Array.from(new Set([
  ...defaultAllowedOrigins.map(normalizeOrigin),
  ...splitEnvList(process.env.CLIENT_ORIGIN),
  ...splitEnvList(process.env.FRONTEND_URL),
  ...splitEnvList(process.env.ALLOWED_ORIGINS),
]));

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  const o = normalizeOrigin(origin);
  if (allowedOrigins.includes(o)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(o)) return true;
  if (
    process.env.ALLOW_VERCEL_PREVIEWS !== 'false' &&
    /^https:\/\/([a-z0-9-]+\.)?vercel\.app$/i.test(o)
  ) return true;
  return false;
};

const corsOptions = {
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    if (!IS_PROD) console.warn('CORS blocked origin:', origin);
    cb(new Error('Blocked by EduFill CORS policy'));
  },
  credentials:         true,
  methods:             ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders:      [
    'Content-Type', 'Authorization',
    'x-user-id', 'x-user-email', 'x-user-phone',
    'x-agent-id', 'x-agent-name', 'x-requested-with',
  ],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '10mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.URLENCODED_BODY_LIMIT || '2mb' }));

// ── Compression — only compress responses > 1 KB ─────────────────────────────
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers.accept === 'text/event-stream') return false; // SSE
    return compression.filter(req, res);
  },
}));

// ── Rate limiter ──────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs:       15 * 60_000,
  max:            Number(process.env.API_RATE_LIMIT_MAX || 500),
  standardHeaders: true,
  legacyHeaders:  false,
  skip:           (req) => req.method === 'OPTIONS',
  message: { error: 'Too many requests. Please try again after 15 minutes.' },
});
app.use('/api/', limiter);

// ─────────────────────────────────────────────
// SOCKET.IO  (initialised before routes so routes can use io via app.locals)
// ─────────────────────────────────────────────
const io = new Server(server, {
  cors:               corsOptions,
  maxHttpBufferSize:  Number(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE || 1e6),
  pingTimeout:        30_000,
  pingInterval:       25_000,
});

setLiveIO(io);
app.set('io', io);
app.locals.io = io;

// ─────────────────────────────────────────────
// SOCKET HELPERS
// ─────────────────────────────────────────────

/**
 * Emit message to a room using ONE canonical event.
 * The client should listen for 'receive_message'.
 * Legacy aliases kept for backward-compat during rollout — remove once
 * all clients are updated.
 */
const emitMessageToRoom = (roomId, message) => {
  const payload = { ...message, roomId };
  io.to(roomId).emit('receive_message',   payload);
  // TODO: remove these three lines once all frontend clients listen on 'receive_message'
  io.to(roomId).emit('receiveMessage',    payload);
  io.to(roomId).emit('chat:new_message',  payload);
  io.to(roomId).emit('live:message',      payload);
};

/**
 * Send only the most recent INITIAL_HISTORY_SIZE messages on join.
 * The client can request older messages via 'load_history'.
 */
const emitHistoryToSocket = (socket, messages = [], roomId = '') => {
  const recent  = messages.slice(-INITIAL_HISTORY_SIZE);
  const hasMore = messages.length > INITIAL_HISTORY_SIZE;

  socket.emit('chat_history',       recent);
  socket.emit('chatHistory',        recent);
  socket.emit('messages',           recent);
  socket.emit('live:chat_history',  { roomId, messages: recent, hasMore });
};

/**
 * Resolve LiveRequest metadata for a room.
 * Results are cached in-process for 10 minutes to avoid N+1 DB queries
 * on every message in an active chat session.
 */
const getRequestMetaForRoom = async (roomId) => {
  const cached = roomMetaCache.get(roomId);
  if (cached) return cached;

  try {
    // Strip known prefixes to get the canonical ID
    const canonical = roomId.replace(/^(live:|request:|room:|room_)/, '');
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(canonical);

    const query = { $or: [{ firebaseRequestId: canonical }] };
    if (isObjectId) query.$or.push({ _id: canonical });

    const request = await LiveRequest.findOne(query).lean();
    if (!request) return roomMetaCache.set(roomId, {});

    const data = {
      requestId:        String(request._id || ''),
      firebaseRequestId: request.firebaseRequestId || '',
      studentId:        request.firebaseUserId || request.userId || '',
      agentId:          String(request.acceptedAgentId || request.offerAgentId || ''),
      studentName:      request.name || request.studentName || 'Student',
      agentName:        request.acceptedAgentName || request.offerAgentName || 'Expert Agent',
    };
    return roomMetaCache.set(roomId, data);
  } catch (err) {
    if (!IS_PROD) console.warn('Unable to resolve live request meta:', err.message);
    return {};
  }
};

const saveSocketMessage = async (roomId, rawMessage, roomMeta = {}) => {
  const cleanRoomId = normalizeRoomId(roomId);
  const message     = buildSocketMessage(rawMessage);

  if (!cleanRoomId || !message.text) {
    const err = Object.assign(new Error('roomId and message text are required.'), { status: 400 });
    throw err;
  }

  const meta = { ...(await getRequestMetaForRoom(cleanRoomId)), ...roomMeta };

  const update = {
    $set: { updatedAt: new Date(), isClosed: false },
    $setOnInsert: {
      roomId:            cleanRoomId,
      requestId:         meta.requestId         || rawMessage.requestId         || '',
      firebaseRequestId: meta.firebaseRequestId  || rawMessage.firebaseRequestId || '',
      studentId:         meta.studentId          || rawMessage.studentId         || '',
      agentId:           meta.agentId            || rawMessage.agentId           || rawMessage.employeeId || '',
      studentName:       sanitizeString(meta.studentName || rawMessage.studentName || 'Student', 80),
      agentName:         sanitizeString(meta.agentName   || rawMessage.agentName   || 'Expert Agent', 80),
      messages:          [],
    },
    $push: {
      messages: {
        $each:  [message],
        $slice: -MAX_SOCKET_HISTORY_MESSAGES,
      },
    },
  };

  await LiveChat.findOneAndUpdate(
    { roomId: cleanRoomId },
    update,
    { upsert: true, new: true, runValidators: true, returnDocument: 'after' }
  );

  return message;
};

// ─────────────────────────────────────────────
// SOCKET.IO EVENT HANDLERS
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  if (!IS_PROD) console.log('Socket connected:', socket.id);

  // ── join_room ──────────────────────────────
  const joinRoomHandler = async (data = {}, ack) => {
    const roomId      = resolveRoomId(data);
    const studentName = sanitizeString(data?.studentName || data?.name || 'Student', 80);
    const agentName   = sanitizeString(data?.agentName || 'Expert Agent', 80);

    if (!roomId) {
      const res = { success: false, message: 'roomId/requestId is required.' };
      socket.emit('chat_error', res);
      if (typeof ack === 'function') ack(res);
      return;
    }

    socket.join(roomId);

    try {
      const requestMeta = await getRequestMetaForRoom(roomId);
      const chatRoom    = await LiveChat.findOneAndUpdate(
        { roomId },
        {
          $set: { updatedAt: new Date(), isClosed: false },
          $setOnInsert: {
            roomId,
            requestId:         requestMeta.requestId         || data.requestId         || '',
            firebaseRequestId: requestMeta.firebaseRequestId  || data.firebaseRequestId || '',
            studentId:         requestMeta.studentId          || data.studentId         || '',
            agentId:           requestMeta.agentId            || data.agentId           || data.employeeId || '',
            studentName:       requestMeta.studentName        || studentName,
            agentName:         requestMeta.agentName          || agentName,
            messages:          [],
          },
        },
        { upsert: true, new: true, runValidators: true, returnDocument: 'after' }
      ).lean();

      const messages = chatRoom?.messages || [];
      emitHistoryToSocket(socket, messages, roomId);

      const res = { success: true, roomId, messages: messages.slice(-INITIAL_HISTORY_SIZE) };
      if (typeof ack === 'function') ack(res);
    } catch (err) {
      console.error('join_room error:', err.message);
      const res = { success: false, message: 'Could not join chat room.', error: err.message };
      socket.emit('chat_error', res);
      if (typeof ack === 'function') ack(res);
    }
  };

  // ── send_message ───────────────────────────
  const sendMessageHandler = async (data = {}, ack) => {
    const roomId = resolveRoomId(data);
    try {
      const messageObj = await saveSocketMessage(roomId, data);
      emitMessageToRoom(roomId, messageObj);
      const res = { success: true, roomId, message: messageObj };
      if (typeof ack === 'function') ack(res);
    } catch (err) {
      console.error('send_message error:', err.message);
      const res = {
        success: false,
        message: err.status === 400 ? err.message : 'Message could not be sent.',
        error:   err.message,
      };
      socket.emit('chat_error', res);
      if (typeof ack === 'function') ack(res);
    }
  };

  // ── load_history (pagination) ──────────────
  socket.on('load_history', async ({ roomId, skip = 0 } = {}, ack) => {
    const cleanId = normalizeRoomId(roomId);
    if (!cleanId) return;
    try {
      const chat    = await LiveChat.findOne({ roomId: cleanId }).select('messages').lean();
      const all     = chat?.messages || [];
      const page    = all.slice(Math.max(0, all.length - INITIAL_HISTORY_SIZE - skip), all.length - skip);
      const payload = { roomId: cleanId, messages: page, hasMore: (all.length - INITIAL_HISTORY_SIZE - skip) > 0 };
      socket.emit('history_page', payload);
      if (typeof ack === 'function') ack(payload);
    } catch (err) {
      console.error('load_history error:', err.message);
    }
  });

  // Register listeners with all known event name aliases
  ['join_room', 'joinRoom', 'chat:join', 'live:join_room'].forEach((e) => socket.on(e, joinRoomHandler));
  ['send_message', 'sendMessage', 'chat:send', 'live:send_message'].forEach((e) => socket.on(e, sendMessageHandler));

  // ── close_and_delete_chat ──────────────────
  socket.on('close_and_delete_chat', async (payload = {}, ack) => {
    const roomId = resolveRoomId(payload);
    if (!roomId) {
      const res = { success: false, message: 'roomId/requestId is required.' };
      if (typeof ack === 'function') ack(res);
      return;
    }

    io.to(roomId).emit('chat_ended', {
      roomId,
      message: 'Form completed successfully. Chat secured & closed.',
    });

    // Evict from meta cache when room closes
    roomMetaCache.del(roomId);

    try {
      const shouldDelete = payload.delete === true || payload.permanentDelete === true;
      if (shouldDelete) {
        await LiveChat.deleteOne({ roomId });
        if (!IS_PROD) console.log(`Chat permanently deleted: ${roomId}`);
      } else {
        await LiveChat.updateOne(
          { roomId },
          { $set: { isClosed: true, closedAt: new Date(), updatedAt: new Date() } }
        );
        if (!IS_PROD) console.log(`Chat closed: ${roomId}`);
      }
      const res = { success: true, roomId, closed: true, deleted: shouldDelete };
      if (typeof ack === 'function') ack(res);
    } catch (err) {
      console.error('close_chat error:', err.message);
      const res = { success: false, message: 'Could not close chat.', error: err.message };
      socket.emit('chat_error', res);
      if (typeof ack === 'function') ack(res);
    }
  });

  // ── presence registration ──────────────────
  socket.on('live_register_student', ({ userId } = {}) => {
    const id = sanitizeString(userId, 120);
    if (id) socket.join(`live_student:${id}`);
  });

  socket.on('live_register_agent', ({ agentId, employeeId } = {}) => {
    [agentId, employeeId]
      .map((id) => sanitizeString(id, 120))
      .filter(Boolean)
      .forEach((id) => socket.join(`live_agent:${id}`));
  });

  socket.on('live_register_admin', () => {
    socket.join('live_admin');
  });

  socket.on('disconnect', () => {
    if (!IS_PROD) console.log('Socket disconnected:', socket.id);
  });
});

// ─────────────────────────────────────────────
// LAZY ROUTE LOADER
// Avoids parsing/compiling all route modules at startup.
// Each route module is loaded on first request and cached by Node's require cache.
// ─────────────────────────────────────────────
const lazyRoute = (routePath) => {
  let router = null;
  return (req, res, next) => {
    if (!router) router = require(routePath);
    router(req, res, next);
  };
};

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health endpoints — no DB, instant response (used by anti-sleep ping too)
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).send('EduFill Backend is Secure, Live & Optimized!');
});

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).json({
    status:   'ok',
    service:  'edufill-backend',
    env:      NODE_ENV,
    mongo:    mongoose.connection.readyState,
    firebase: Boolean(app.locals.firestore),
    time:     new Date().toISOString(),
  });
});

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).json({ status: 'ok', service: 'edufill-api', time: new Date().toISOString() });
});

// ── API routes (lazy-loaded) ──────────────────
app.use('/api/colleges', lazyRoute('./routes/collegeRoutes'));
app.use('/api/blogs',    lazyRoute('./routes/blogRoutes'));
app.use('/api/exams',    lazyRoute('./routes/examRoutes'));
app.use('/api/live',     lazyRoute('./routes/liveConnectRoutes'));

// ── Sitemap — with 1-hour in-memory cache ────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  res.setHeader('Content-Type',  'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  const CACHE_KEY = 'sitemap';
  const cached    = sitemapCache.get(CACHE_KEY);
  if (cached) return res.status(200).send(cached);

  try {
    const blogs = await Blog.find({ status: 'Published' })
      .select('slug updatedAt')
      .lean();

    const xml = buildSitemapXml(blogs);
    sitemapCache.set(CACHE_KEY, xml);
    res.status(200).send(xml);
  } catch (err) {
    console.error('Sitemap error:', err.message);
    // Serve stale cache rather than returning 500 (better for SEO)
    const stale = sitemapCache.get(CACHE_KEY);
    if (stale) return res.status(200).send(stale);
    res.status(500).send('Error generating sitemap');
  }
});

// ── robots.txt — served dynamically so you can update without a deploy ────────
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type',  'text/plain');
  res.setHeader('Cache-Control', 'public, max-age=86400'); // cache 24 hours
  res.status(200).send(
    [
      'User-agent: *',
      'Allow: /',
      '',
      '# Block admin/private paths',
      'Disallow: /api/',
      'Disallow: /admin/',
      'Disallow: /dashboard/',
      '',
      `Sitemap: ${SITE_URL}/sitemap.xml`,
    ].join('\n')
  );
});

// ── 404 handler ───────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'API route not found' });
});

// ── Global error handler ──────────────────────
app.use((err, req, res, _next) => {
  const statusCode = err.status || err.statusCode || 500;
  if (!IS_PROD) console.error('Global error:', err);
  res.status(statusCode).json({
    success: false,
    message: statusCode === 500 ? 'Internal server error' : err.message,
  });
});

// ─────────────────────────────────────────────
// ANTI-SLEEP SELF-PING  (Render Free Plan keep-alive)
// Pings every 5 minutes — well inside Render's 15-minute sleep threshold.
// Fires immediately once on startup, then on interval.
// ─────────────────────────────────────────────
const PING_INTERVAL_MS = 5 * 60_000;

const pingServer = (url, retries = 3) => {
  const mod = url.startsWith('https') ? https : http;
  const req = mod.get(`${url}/health`, (res) => {
    res.resume();
    if (!IS_PROD) console.log(`[Ping] ${res.statusCode} at ${new Date().toISOString()}`);
  });
  req.setTimeout(10_000, () => {
    req.destroy();
    if (retries > 0) setTimeout(() => pingServer(url, retries - 1), 5000);
  });
  req.on('error', (err) => {
    console.warn(`[Ping] Failed: ${err.message}`);
    if (retries > 0) setTimeout(() => pingServer(url, retries - 1), 5000);
  });
};

const startAntiSleep = () => {
  if (!SERVER_URL || !IS_PROD) return;
  pingServer(SERVER_URL);                          // immediate first ping on startup
  const timer = setInterval(() => pingServer(SERVER_URL), PING_INTERVAL_MS);
  timer.unref?.();
  console.log(`Anti-sleep ping active: ${SERVER_URL} every ${PING_INTERVAL_MS / 60_000} min`);
};

// ─────────────────────────────────────────────
// SERVER STARTUP — sequential, reliable, fast
// MongoDB + Firebase init in parallel BEFORE the
// server starts accepting requests so the first
// real request never pays connection setup costs.
// ─────────────────────────────────────────────
const startServer = async () => {
  try {
    // Init DB + Firebase in parallel — saves 300–800ms on cold start
    const [, db] = await Promise.all([
      connectMongoDB(),
      initFirebase(),
    ]);

    app.locals.firestore = db;

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT} in ${NODE_ENV} mode`);

      // Defer background jobs so the event loop is free to handle
      // the first incoming requests immediately after listen()
      setImmediate(() => {
        try { startLiveOfferTimeoutJob(); }
        catch (e) { console.error('Live offer job failed:', e.message); }

        try { startFirestoreLiveBridge(); }
        catch (e) { console.error('Firestore bridge failed:', e.message); }

        startAntiSleep();
      });
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
};

startServer();

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
  console.log(`${signal} received — shutting down EduFill backend...`);
  server.close(async () => {
    try {
      await mongoose.connection.close(false);
      console.log('MongoDB connection closed');
    } catch (e) {
      console.error('MongoDB close error:', e.message);
    }
    process.exit(0);
  });
  // Force exit if graceful shutdown takes too long
  setTimeout(() => process.exit(1), 10_000).unref?.();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});