const express = require('express');
const admin = require('firebase-admin');
const LiveAgent = require('../models/LiveAgent');
const LiveRequest = require('../models/LiveRequest');
const LiveOffer = require('../models/LiveOffer');
const LiveChat = require('../models/LiveChat');
const firebaseStudentAuth = require('../middleware/firebaseStudentAuth');
const {
  routeRequestToNextAgent,
  acceptRequest,
  skipRequest,
  completeRequest,
  unblockAgent,
  mirrorFirestoreRequest,
  STATUS,
} = require('../services/liveDispatcher');

const router = express.Router();

function ok(res, data = {}) {
  return res.status(200).json({ success: true, ...data });
}

function fail(res, status, message, error = null) {
  return res.status(status).json({ success: false, message, error: error?.message });
}

function hasDocs(docs = {}) {
  return Object.values(docs || {}).some(Boolean);
}

router.get('/health', (req, res) => ok(res, { message: 'EduFill Live API is working', time: new Date().toISOString() }));

const MAX_CHAT_MESSAGE_LENGTH = Number(process.env.MAX_CHAT_MESSAGE_LENGTH || 2000);
const MAX_CHAT_HISTORY_MESSAGES = Number(process.env.MAX_CHAT_HISTORY_MESSAGES || 200);

function sanitizeString(value, maxLength = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeSenderType(value) {
  const type = sanitizeString(value, 30).toLowerCase();

  if (['agent', 'expert', 'employee', 'staff'].includes(type)) return 'agent';
  if (['admin', 'administrator'].includes(type)) return 'admin';
  if (['system', 'bot'].includes(type)) return 'system';
  return 'student';
}

function makeRoomCandidates(roomId) {
  const clean = sanitizeString(roomId, 160);
  return Array.from(new Set([
    clean,
    `live:${clean}`,
    `request:${clean}`,
    `room:${clean}`,
    `room_${clean}`,
  ].filter(Boolean)));
}

function getRoomIdFromRequest(req) {
  return sanitizeString(
    req.params.roomId ||
    req.params.requestId ||
    req.body.roomId ||
    req.body.requestId ||
    req.body.firebaseRequestId,
    160
  );
}

function buildRestMessage(req) {
  const body = req.body || {};
  return {
    senderId: sanitizeString(
      body.senderId ||
      body.userId ||
      body.studentId ||
      body.agentId ||
      body.employeeId ||
      req.headers['x-user-id'] ||
      req.headers['x-agent-id'] ||
      '',
      120
    ),
    senderName: sanitizeString(body.senderName || body.name || body.studentName || body.agentName || req.headers['x-agent-name'] || '', 80),
    senderType: normalizeSenderType(body.senderType || body.senderRole || body.role || body.type || req.headers['x-sender-type']),
    text: sanitizeString(body.text || body.message || body.content || '', MAX_CHAT_MESSAGE_LENGTH),
    timestamp: new Date(),
  };
}

async function getRequestMeta(roomId) {
  try {
    const candidates = makeRoomCandidates(roomId);
    const mongoId = candidates.find((id) => /^[0-9a-fA-F]{24}$/.test(id));

    const request = await LiveRequest.findOne({
      $or: [
        ...(mongoId ? [{ _id: mongoId }] : []),
        { firebaseRequestId: { $in: candidates } },
      ],
    }).lean();

    if (!request) return {};

    return {
      requestId: String(request._id || ''),
      firebaseRequestId: request.firebaseRequestId || '',
      studentId: request.firebaseUserId || request.userId || '',
      agentId: String(request.acceptedAgentId || request.offerAgentId || ''),
      studentName: request.name || request.studentName || 'Student',
      agentName: request.acceptedAgentName || request.offerAgentName || 'Expert Agent',
    };
  } catch (error) {
    console.warn('Unable to read request meta for chat:', error.message);
    return {};
  }
}

function emitChatMessage(req, roomId, message) {
  const io = req.app.get('io') || req.app.locals.io;
  if (!io) return;

  const payload = { ...message, roomId };
  io.to(roomId).emit('receive_message', payload);
  io.to(roomId).emit('receiveMessage', payload);
  io.to(roomId).emit('chat:new_message', payload);
  io.to(roomId).emit('live:message', payload);
}

// ===========================
// LIVE CHAT REST API
// Works with both roomId and requestId so frontend can call any one of these:
// GET  /api/live/chat/:roomId/messages
// POST /api/live/chat/:roomId/message
// GET  /api/live/request/:requestId/chat
// POST /api/live/request/:requestId/chat/message
// ===========================

router.get(['/chat/:roomId', '/chat/:roomId/messages', '/request/:requestId/chat', '/request/:requestId/messages'], async (req, res) => {
  try {
    const roomId = getRoomIdFromRequest(req);
    if (!roomId) return fail(res, 400, 'roomId/requestId is required.');

    const candidates = makeRoomCandidates(roomId);
    const chat = await LiveChat.findOne({ roomId: { $in: candidates } }).lean();

    return ok(res, {
      roomId: chat?.roomId || roomId,
      chat: chat || null,
      messages: (chat?.messages || []).slice(-MAX_CHAT_HISTORY_MESSAGES),
    });
  } catch (error) {
    return fail(res, 500, 'Unable to load chat messages.', error);
  }
});

router.post(['/chat/:roomId/message', '/chat/:roomId/messages', '/request/:requestId/chat/message', '/request/:requestId/messages'], async (req, res) => {
  try {
    const roomId = getRoomIdFromRequest(req);
    const message = buildRestMessage(req);

    if (!roomId) return fail(res, 400, 'roomId/requestId is required.');
    if (!message.text) return fail(res, 400, 'Message text is required.');

    const meta = await getRequestMeta(roomId);

    await LiveChat.findOneAndUpdate(
      { roomId },
      {
        $set: {
          updatedAt: new Date(),
          isClosed: false,
        },
        $setOnInsert: {
          roomId,
          requestId: meta.requestId || req.body.requestId || '',
          firebaseRequestId: meta.firebaseRequestId || req.body.firebaseRequestId || '',
          studentId: meta.studentId || req.body.studentId || '',
          agentId: meta.agentId || req.body.agentId || req.body.employeeId || '',
          studentName: sanitizeString(meta.studentName || req.body.studentName || 'Student', 80),
          agentName: sanitizeString(meta.agentName || req.body.agentName || 'Expert Agent', 80),
          messages: [],
        },
        $push: {
          messages: {
            $each: [message],
            $slice: -MAX_CHAT_HISTORY_MESSAGES,
          },
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        returnDocument: 'after',
      }
    );

    emitChatMessage(req, roomId, message);

    return res.status(201).json({ success: true, roomId, message });
  } catch (error) {
    return fail(res, 500, 'Message could not be sent.', error);
  }
});


// ===========================
// STUDENT API
// ===========================

router.post(['/student/request', '/student/live-requests'], firebaseStudentAuth, async (req, res) => {
  try {
    const { name, mobile, exam, documents = {}, vaultDocuments = {} } = req.body;
    if (!name || !mobile || !exam) return fail(res, 400, 'name, mobile and exam are required.');

    const active = await LiveRequest.findOne({
      firebaseUserId: req.student.uid,
      status: { $in: [STATUS.SEARCHING, STATUS.OFFERED, STATUS.ACCEPTED, STATUS.IN_PROGRESS] },
    }).sort({ createdAt: -1 });

    if (active) return ok(res, { request: active, message: 'Existing active request returned.' });

    const mergedDocs = { ...vaultDocuments, ...documents };

    const request = await LiveRequest.create({
      firebaseUserId: req.student.uid,
      userId: req.student.uid,
      userEmail: req.student.email || req.body.userEmail || '',
      userPhone: req.body.userPhone || mobile,
      name,
      mobile,
      exam,
      documents: mergedDocs,
      vaultDocuments: mergedDocs,
      hasUploadedDocuments: hasDocs(mergedDocs),
      status: STATUS.SEARCHING,
      routingStatus: 'created',
    });

    routeRequestToNextAgent(request._id, { reason: 'student_api_new_request' }).catch(console.error);

    return res.status(201).json({ success: true, request });
  } catch (error) {
    console.error(error);
    return fail(res, 500, 'Request create failed.', error);
  }
});

router.get(['/student/requests', '/student/live-requests'], firebaseStudentAuth, async (req, res) => {
  try {
    const requests = await LiveRequest.find({ firebaseUserId: req.student.uid }).sort({ createdAt: -1 }).limit(50);
    return ok(res, { requests });
  } catch (error) {
    return fail(res, 500, 'Unable to load requests.', error);
  }
});

router.patch(['/student/request/:id/cancel', '/student/live-requests/:id/cancel', '/student/live-request/:id/cancel'], firebaseStudentAuth, async (req, res) => {
  try {
    const request = await LiveRequest.findOneAndUpdate(
      {
        _id: req.params.id,
        firebaseUserId: req.student.uid,
        status: { $in: [STATUS.SEARCHING, STATUS.OFFERED] },
      },
      {
        $set: {
          status: STATUS.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: 'student_cancelled',
          offerAgentId: null,
          offerAgentEmployeeId: null,
          offerAgentName: null,
          offerExpiresAt: null,
          offerToken: null,
        },
      },
      { returnDocument: 'after' }
    );

    if (!request) return fail(res, 409, 'Request cannot be cancelled now.');

    if (request.firebaseRequestId && admin.apps?.length) {
      await admin.firestore().collection('Live_Form_Requests').doc(request.firebaseRequestId).set({
        status: 'Cancelled',
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    try {
      const { emitToLiveStudent, emitToLiveAdmin } = require('../services/liveSocketHub');
      emitToLiveStudent(request.firebaseUserId || request.userId, 'live:request_cancelled', {
        requestId: String(request._id),
        firebaseRequestId: request.firebaseRequestId,
        status: 'Cancelled',
      });
      emitToLiveAdmin('live:request_cancelled', { requestId: String(request._id) });
    } catch (_) {}

    return ok(res, { request });
  } catch (error) {
    return fail(res, 500, 'Cancel failed.', error);
  }
});

// ===========================
// AGENT API
// ===========================

// Agent panel should call this once after existing Firestore login.
// Body: { employeeId, name, institute, phone, skills }
router.post('/agent/sync', async (req, res) => {
  try {
    const {
      employeeId,
      name,
      institute = 'Online',
      phone = '',
      email = '',
      skills = ['ALL'],
      agentType: rawAgentType,
      isOnlineAgent,
    } = req.body;
    if (!employeeId || !name) return fail(res, 400, 'employeeId and name are required.');

    const typeText = String(rawAgentType || '').toLowerCase();
    const instituteText = String(institute || '').toLowerCase();
    const agentType = isOnlineAgent === true || typeText.includes('online') || instituteText.includes('online')
      ? 'online'
      : 'camp';

    const agent = await LiveAgent.findOneAndUpdate(
      { employeeId },
      {
        $set: {
          employeeId,
          name,
          institute,
          phone,
          email,
          skills: Array.isArray(skills) && skills.length ? skills : ['ALL'],
          agentType,
          active: true,
          lastHeartbeatAt: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    return ok(res, { agent });
  } catch (error) {
    return fail(res, 500, 'Agent sync failed.', error);
  }
});

router.patch(['/agent/:agentKey/live', '/agent/:agentKey/live-status'], async (req, res) => {
  try {
    const key = req.params.agentKey;
    const { isLiveOnline } = req.body;

    const filter = key.match(/^[0-9a-fA-F]{24}$/) ? { _id: key } : { employeeId: key };

    const liveSet = {
      isLiveOnline: Boolean(isLiveOnline),
      liveStatus: isLiveOnline ? 'online' : 'offline',
      lastHeartbeatAt: new Date(),
      ...(isLiveOnline ? { agentType: 'online' } : { isBusy: false, currentLiveRequestId: null }),
    };

    const agent = await LiveAgent.findOneAndUpdate(
      filter,
      { $set: liveSet },
      { returnDocument: 'after' }
    );

    if (!agent) return fail(res, 404, 'Agent not found. Call /agent/sync first.');

    if (isLiveOnline) {
      const waiting = await LiveRequest.findOne({ status: STATUS.SEARCHING, offerAgentId: null }).sort({ createdAt: 1 });
      if (waiting) routeRequestToNextAgent(waiting._id, { reason: 'agent_came_live' }).catch(console.error);
    }

    return ok(res, { agent });
  } catch (error) {
    return fail(res, 500, 'Live status update failed.', error);
  }
});

router.post('/agent/:agentKey/heartbeat', async (req, res) => {
  try {
    const key = req.params.agentKey;
    const filter = key.match(/^[0-9a-fA-F]{24}$/) ? { _id: key } : { employeeId: key };
    await LiveAgent.updateOne(filter, { $set: { lastHeartbeatAt: new Date() } });
    return ok(res);
  } catch (error) {
    return fail(res, 500, 'Heartbeat failed.', error);
  }
});

router.get('/agent/:agentKey/offers', async (req, res) => {
  try {
    const key = req.params.agentKey;
    const filter = key.match(/^[0-9a-fA-F]{24}$/)
      ? { offerAgentId: key }
      : { offerAgentEmployeeId: key };

    const offers = await LiveRequest.find({
      ...filter,
      status: STATUS.OFFERED,
      offerExpiresAt: { $gt: new Date() },
    }).sort({ offerExpiresAt: 1 });

    return ok(res, { offers });
  } catch (error) {
    return fail(res, 500, 'Unable to load offers.', error);
  }
});

router.get('/agent/:agentKey/queue', async (req, res) => {
  try {
    const key = req.params.agentKey;
    const filter = key.match(/^[0-9a-fA-F]{24}$/)
      ? { acceptedAgentId: key }
      : { acceptedAgentEmployeeId: key };

    const queue = await LiveRequest.find({
      ...filter,
      status: { $in: [STATUS.ACCEPTED, STATUS.IN_PROGRESS] },
    }).sort({ acceptedAt: -1 });

    return ok(res, { queue });
  } catch (error) {
    return fail(res, 500, 'Unable to load queue.', error);
  }
});

router.post('/agent/:agentKey/request/:requestId/accept', async (req, res) => {
  try {
    const key = req.params.agentKey;
    const result = await acceptRequest({
      requestId: req.params.requestId.match(/^[0-9a-fA-F]{24}$/) ? req.params.requestId : null,
      firebaseRequestId: req.params.requestId.match(/^[0-9a-fA-F]{24}$/) ? null : req.params.requestId,
      agentId: key.match(/^[0-9a-fA-F]{24}$/) ? key : null,
      employeeId: key.match(/^[0-9a-fA-F]{24}$/) ? null : key,
    });

    return ok(res, { request: result });
  } catch (error) {
    return fail(res, 409, error.message || 'Accept failed.', error);
  }
});

router.post('/agent/:agentKey/request/:requestId/skip', async (req, res) => {
  try {
    const key = req.params.agentKey;
    const result = await skipRequest({
      requestId: req.params.requestId.match(/^[0-9a-fA-F]{24}$/) ? req.params.requestId : null,
      firebaseRequestId: req.params.requestId.match(/^[0-9a-fA-F]{24}$/) ? null : req.params.requestId,
      agentId: key.match(/^[0-9a-fA-F]{24}$/) ? key : null,
      employeeId: key.match(/^[0-9a-fA-F]{24}$/) ? null : key,
      reason: req.body.reason || 'manual_skip',
    });

    return ok(res, { request: result });
  } catch (error) {
    return fail(res, 409, error.message || 'Skip failed.', error);
  }
});

router.post('/agent/:agentKey/request/:requestId/complete', async (req, res) => {
  try {
    const key = req.params.agentKey;
    const result = await completeRequest({
      requestId: req.params.requestId.match(/^[0-9a-fA-F]{24}$/) ? req.params.requestId : null,
      firebaseRequestId: req.params.requestId.match(/^[0-9a-fA-F]{24}$/) ? null : req.params.requestId,
      agentId: key.match(/^[0-9a-fA-F]{24}$/) ? key : null,
      employeeId: key.match(/^[0-9a-fA-F]{24}$/) ? null : key,
      applicationNumber: req.body.applicationNumber,
      legacySafe: req.body?.legacySafe === true,
    });

    return ok(res, { request: result });
  } catch (error) {
    return fail(res, 409, error.message || 'Complete failed.', error);
  }
});


router.post('/agent/:agentKey/unblock', async (req, res) => {
  try {
    const key = req.params.agentKey;
    const result = await unblockAgent({
      agentId: key.match(/^[0-9a-fA-F]{24}$/) ? key : null,
      employeeId: key.match(/^[0-9a-fA-F]{24}$/) ? null : key,
      requestId: req.body?.requestId && String(req.body.requestId).match(/^[0-9a-fA-F]{24}$/) ? req.body.requestId : null,
      firebaseRequestId:
        req.body?.firebaseRequestId ||
        (req.body?.requestId && !String(req.body.requestId).match(/^[0-9a-fA-F]{24}$/) ? req.body.requestId : null),
      applicationNumber: req.body?.applicationNumber || 'N/A',
      keepOnline: req.body?.keepOnline !== false,
    });

    return ok(res, result);
  } catch (error) {
    return fail(res, 500, 'Agent unblock failed.', error);
  }
});

// ===========================
// ADMIN / DEBUG API
// ===========================

router.get('/admin/requests', async (req, res) => {
  try {
    const requests = await LiveRequest.find().sort({ createdAt: -1 }).limit(200).populate('offerAgentId acceptedAgentId');
    return ok(res, { requests });
  } catch (error) {
    return fail(res, 500, 'Unable to load admin requests.', error);
  }
});

router.post('/admin/request/:id/dispatch', async (req, res) => {
  try {
    const result = await routeRequestToNextAgent(req.params.id, { reason: 'admin_force_dispatch', force: true });
    return ok(res, { request: result });
  } catch (error) {
    return fail(res, 500, 'Dispatch failed.', error);
  }
});

// Firestore bridge endpoint: use if frontend still creates Live_Form_Requests directly.
router.post('/bridge/firestore-request/:firebaseRequestId', async (req, res) => {
  try {
    const request = await mirrorFirestoreRequest(req.params.firebaseRequestId, req.body || {});
    return ok(res, { request });
  } catch (error) {
    return fail(res, 500, 'Firestore bridge failed.', error);
  }
});

module.exports = router;
