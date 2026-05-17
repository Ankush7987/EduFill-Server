const admin = require('firebase-admin');

function decodeJwtPayloadUnsafe(token = '') {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return {};
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) || {};
  } catch (_) {
    return {};
  }
}

function fallbackStudent(req, token = '') {
  const decoded = decodeJwtPayloadUnsafe(token);
  return {
    uid:
      req.headers['x-user-id'] ||
      req.body?.userId ||
      req.body?.firebaseUserId ||
      req.query?.userId ||
      decoded.user_id ||
      decoded.sub ||
      'dev-student',
    email:
      req.headers['x-user-email'] ||
      req.body?.userEmail ||
      req.body?.email ||
      decoded.email ||
      '',
  };
}

async function firebaseStudentAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const requireAuth = process.env.REQUIRE_FIREBASE_AUTH === 'true';

    // Local/dev mode: if Firebase Admin is not configured, still keep the real
    // Firebase UID by reading x-user-id or decoding the token payload. This fixes
    // GET/cancel mismatches where POST used real userId but later requests became "dev-student".
    if (!requireAuth && (!admin.apps?.length)) {
      req.student = fallbackStudent(req, token || '');
      return next();
    }

    if (!token) {
      if (!requireAuth) {
        req.student = fallbackStudent(req, '');
        return next();
      }
      return res.status(401).json({ success: false, message: 'Firebase ID token required.' });
    }

    if (!admin.apps?.length) {
      if (!requireAuth) {
        req.student = fallbackStudent(req, token);
        return next();
      }
      return res.status(500).json({ success: false, message: 'Firebase Admin not initialized. Set REQUIRE_FIREBASE_AUTH=false for local testing or configure service account.' });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.student = decoded;
    next();
  } catch (error) {
    if (process.env.REQUIRE_FIREBASE_AUTH !== 'true') {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      req.student = fallbackStudent(req, token);
      return next();
    }
    res.status(401).json({ success: false, message: 'Invalid Firebase token.' });
  }
}

module.exports = firebaseStudentAuth;
