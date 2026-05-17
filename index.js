const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const mongoose = require('mongoose');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const https = require('https');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
require('dotenv').config();

const Blog = require('./models/Blog');
const LiveChat = require('./models/LiveChat');
const { setLiveIO } = require('./services/liveSocketHub');
const { startLiveOfferTimeoutJob } = require('./jobs/liveOfferTimeoutJob');
const { startFirestoreLiveBridge } = require('./jobs/firestoreLiveBridge');

const app = express();
const server = http.createServer(app);

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 5000;
const SITE_URL = (process.env.SITE_URL || 'https://edufills.com').replace(/\/$/, '');
const MAX_SOCKET_MESSAGE_LENGTH = Number(process.env.MAX_SOCKET_MESSAGE_LENGTH || 2000);
const MAX_SOCKET_HISTORY_MESSAGES = Number(process.env.MAX_SOCKET_HISTORY_MESSAGES || 200);

const sanitizeString = (value, maxLength = 500) => {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
};

const normalizeOrigin = (origin) => String(origin || '').trim().replace(/\/$/, '');

const splitEnvList = (value) => {
  return String(value || '')
    .split(',')
    .map((item) => normalizeOrigin(item))
    .filter(Boolean);
};

const escapeXml = (value) => {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

const safeDate = (value, fallback = new Date()) => {
  const date = value ? new Date(value) : fallback;
  if (Number.isNaN(date.getTime())) return fallback.toISOString().split('T')[0];
  return date.toISOString().split('T')[0];
};

const getFirebaseServiceAccount = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }

    return parsed;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credentialPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    return require(credentialPath);
  }

  return null;
};

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

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

const allowedOrigins = Array.from(
  new Set([
    ...defaultAllowedOrigins.map(normalizeOrigin),
    ...splitEnvList(process.env.CLIENT_ORIGIN),
    ...splitEnvList(process.env.FRONTEND_URL),
    ...splitEnvList(process.env.ALLOWED_ORIGINS),
  ])
);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;

  const normalizedOrigin = normalizeOrigin(origin);
  if (allowedOrigins.includes(normalizedOrigin)) return true;

  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(normalizedOrigin)) return true;

  if (
    process.env.ALLOW_VERCEL_PREVIEWS !== 'false' &&
    /^https:\/\/([a-z0-9-]+\.)?vercel\.app$/i.test(normalizedOrigin)
  ) {
    return true;
  }

  return false;
};

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    if (!IS_PRODUCTION) {
      console.warn('CORS blocked origin:', origin);
    }

    callback(new Error('Blocked by EduFill CORS policy'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-user-id',
    'x-user-email',
    'x-user-phone',
    'x-agent-id',
    'x-agent-name',
    'x-requested-with',
  ],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '10mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.URLENCODED_BODY_LIMIT || '2mb' }));
app.use(compression());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 500),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  message: {
    error: 'Too many requests from this IP, please try again after 15 minutes.',
  },
});

app.use('/api/', limiter);

let db = null;

try {
  const serviceAccount = getFirebaseServiceAccount();

  if (serviceAccount) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    db = admin.firestore();
    app.locals.firestore = db;
    console.log('Firebase Admin connected');
  } else {
    console.warn('Firebase Admin skipped: FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS is missing.');
  }
} catch (error) {
  console.error('Firebase setup error:', error.message);
}

mongoose.set('strictQuery', false);

const connectMongoDB = async () => {
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    console.error('MONGO_URI is missing in environment variables.');
    return;
  }

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 10000),
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 10),
    });

    console.log('MongoDB Atlas connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
  }
};

connectMongoDB();

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected');
});

mongoose.connection.on('error', (error) => {
  console.error('MongoDB runtime error:', error.message);
});

const io = new Server(server, {
  cors: corsOptions,
  maxHttpBufferSize: Number(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE || 1e6),
});

setLiveIO(io);

io.on('connection', (socket) => {
  if (!IS_PRODUCTION) {
    console.log('User connected to chat:', socket.id);
  }

  socket.on('join_room', async (data = {}) => {
    const roomId = sanitizeString(data?.roomId || data, 120);
    const studentName = sanitizeString(data?.studentName || 'Student', 80);
    const agentName = sanitizeString(data?.agentName || 'Expert Agent', 80);

    if (!roomId) return;

    socket.join(roomId);

    try {
      const chatRoom = await LiveChat.findOneAndUpdate(
        { roomId },
        {
          $setOnInsert: {
            roomId,
            studentName,
            agentName,
            messages: [],
          },
        },
        {
          upsert: true,
          new: true,
          returnDocument: 'after',
        }
      ).lean();

      if (chatRoom?.messages?.length) {
        socket.emit('chat_history', chatRoom.messages.slice(-MAX_SOCKET_HISTORY_MESSAGES));
      }
    } catch (error) {
      console.error('Error joining chat room:', error.message);
      socket.emit('chat_error', { message: 'Could not join chat room.' });
    }
  });

  socket.on('send_message', async (data = {}) => {
    const roomId = sanitizeString(data.roomId, 120);
    const senderId = sanitizeString(data.senderId, 120);
    const senderType = sanitizeString(data.senderType, 30);
    const text = sanitizeString(data.text, MAX_SOCKET_MESSAGE_LENGTH);

    if (!roomId || !text) return;

    const messageObj = {
      senderId,
      senderType,
      text,
      timestamp: new Date(),
    };

    try {
      await LiveChat.findOneAndUpdate(
        { roomId },
        {
          $setOnInsert: { roomId },
          $push: {
            messages: {
              $each: [messageObj],
              $slice: -MAX_SOCKET_HISTORY_MESSAGES,
            },
          },
        },
        {
          upsert: true,
          new: true,
          returnDocument: 'after',
        }
      );

      io.to(roomId).emit('receive_message', messageObj);
    } catch (error) {
      console.error('Error saving message to DB:', error.message);
      socket.emit('chat_error', { message: 'Message could not be sent.' });
    }
  });

  socket.on('close_and_delete_chat', async (payload = {}) => {
    const roomId = sanitizeString(payload.roomId, 120);
    if (!roomId) return;

    io.to(roomId).emit('chat_ended', {
      message: 'Form completed successfully. Chat secured & closed.',
    });

    try {
      await LiveChat.deleteOne({ roomId });
      if (!IS_PRODUCTION) console.log(`Ephemeral chat deleted for room ${roomId}`);
    } catch (error) {
      console.error('Error deleting chat:', error.message);
    }
  });

  socket.on('live_register_student', ({ userId } = {}) => {
    const cleanUserId = sanitizeString(userId, 120);
    if (!cleanUserId) return;
    socket.join(`live_student:${cleanUserId}`);
  });

  socket.on('live_register_agent', ({ agentId, employeeId } = {}) => {
    const ids = [agentId, employeeId]
      .map((id) => sanitizeString(id, 120))
      .filter(Boolean);

    ids.forEach((id) => socket.join(`live_agent:${id}`));
  });

  socket.on('live_register_admin', () => {
    socket.join('live_admin');
  });

  socket.on('disconnect', () => {
    if (!IS_PRODUCTION) {
      console.log('User disconnected from chat:', socket.id);
    }
  });
});

app.get('/', (req, res) => {
  res.status(200).send('EduFill Backend is Secure, Live & Optimized!');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'edufill-backend',
    env: NODE_ENV,
    mongo: mongoose.connection.readyState,
    firebase: Boolean(db),
    time: new Date().toISOString(),
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'edufill-api',
    time: new Date().toISOString(),
  });
});

const collegeRoutes = require('./routes/collegeRoutes');
app.use('/api/colleges', collegeRoutes);

const blogRoutes = require('./routes/blogRoutes');
app.use('/api/blogs', blogRoutes);

const examRoutes = require('./routes/examRoutes');
app.use('/api/exams', examRoutes);

const liveConnectRoutes = require('./routes/liveConnectRoutes');
app.use('/api/live', liveConnectRoutes);

app.get('/sitemap.xml', async (req, res) => {
  try {
    const blogs = await Blog.find({ status: 'Published' }).select('slug updatedAt').lean();
    const today = new Date().toISOString().split('T')[0];

    const staticUrls = [
      { loc: '/', priority: '1.0', changefreq: 'daily' },
      { loc: '/college-predictor', priority: '0.9', changefreq: 'daily' },
      { loc: '/mock-test', priority: '0.9', changefreq: 'daily' },
      { loc: '/campus-drive', priority: '0.9', changefreq: 'weekly' },
      { loc: '/apply/neet', priority: '0.9', changefreq: 'weekly' },
      { loc: '/apply/jee', priority: '0.9', changefreq: 'weekly' },
      { loc: '/apply/cuet', priority: '0.9', changefreq: 'weekly' },
      { loc: '/apply/govt-college', priority: '0.9', changefreq: 'weekly' },
      { loc: '/tools', priority: '0.9', changefreq: 'weekly' },
      { loc: '/tools/photo-date', priority: '0.85', changefreq: 'weekly' },
      { loc: '/tools/resizer', priority: '0.85', changefreq: 'weekly' },
      { loc: '/tools/pdf-maker', priority: '0.85', changefreq: 'weekly' },
      { loc: '/tools/pdf-compressor', priority: '0.85', changefreq: 'weekly' },
      { loc: '/blogs', priority: '0.9', changefreq: 'daily' },
      { loc: '/exams', priority: '0.9', changefreq: 'daily' },
      { loc: '/about', priority: '0.8', changefreq: 'monthly' },
      { loc: '/contact', priority: '0.8', changefreq: 'monthly' },
      { loc: '/privacy-policy', priority: '0.5', changefreq: 'yearly' },
      { loc: '/terms-and-conditions', priority: '0.5', changefreq: 'yearly' },
      { loc: '/refund-policy', priority: '0.5', changefreq: 'yearly' },
    ];

    const urls = staticUrls
      .map((link) => {
        return [
          '  <url>',
          `    <loc>${escapeXml(`${SITE_URL}${link.loc}`)}</loc>`,
          `    <lastmod>${today}</lastmod>`,
          `    <changefreq>${link.changefreq}</changefreq>`,
          `    <priority>${link.priority}</priority>`,
          '  </url>',
        ].join('\n');
      })
      .join('\n');

    const blogUrls = blogs
      .filter((blog) => blog.slug)
      .map((blog) => {
        return [
          '  <url>',
          `    <loc>${escapeXml(`${SITE_URL}/blog/${blog.slug}`)}</loc>`,
          `    <lastmod>${safeDate(blog.updatedAt)}</lastmod>`,
          '    <changefreq>weekly</changefreq>',
          '    <priority>0.8</priority>',
          '  </url>',
        ].join('\n');
      })
      .join('\n');

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      urls,
      blogUrls,
      '</urlset>',
    ]
      .filter(Boolean)
      .join('\n');

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(xml);
  } catch (error) {
    console.error('Sitemap error:', error.message);
    res.status(500).send('Error generating sitemap');
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'API route not found',
  });
});

app.use((error, req, res, next) => {
  const statusCode = error.status || error.statusCode || 500;

  if (!IS_PRODUCTION) {
    console.error('Global error handler:', error);
  }

  res.status(statusCode).json({
    success: false,
    message: statusCode === 500 ? 'Internal server error' : error.message,
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT} in ${NODE_ENV} mode`);

  try {
    startLiveOfferTimeoutJob();
  } catch (error) {
    console.error('Live offer timeout job failed to start:', error.message);
  }

  try {
    startFirestoreLiveBridge();
  } catch (error) {
    console.error('Firestore live bridge failed to start:', error.message);
  }

  const serverUrl = process.env.SERVER_URL;

  if (serverUrl && IS_PRODUCTION) {
    const antiSleepTimer = setInterval(() => {
      const pingModule = serverUrl.startsWith('https') ? https : http;

      const request = pingModule.get(serverUrl, (response) => {
        response.resume();
        console.log(`[Anti-Sleep Ping] Server Status: ${response.statusCode} at ${new Date().toLocaleTimeString()}`);
      });

      request.setTimeout(15000, () => {
        request.destroy(new Error('Anti-sleep ping timeout'));
      });

      request.on('error', (error) => {
        console.error(`[Anti-Sleep Ping] Failed: ${error.message}`);
      });
    }, 10 * 60 * 1000);

    antiSleepTimer.unref?.();
    console.log(`Anti-sleep self-pinging initialized for: ${serverUrl}`);
  }
});

const gracefulShutdown = async (signal) => {
  console.log(`${signal} received. Closing EduFill backend...`);

  server.close(async () => {
    try {
      await mongoose.connection.close(false);
      console.log('MongoDB connection closed');
    } catch (error) {
      console.error('MongoDB close error:', error.message);
    }

    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref?.();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});