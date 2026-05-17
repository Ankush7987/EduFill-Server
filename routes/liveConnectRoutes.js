const express = require('express');
const admin = require('firebase-admin');
const LiveAgent = require('../models/LiveAgent');
const LiveRequest = require('../models/LiveRequest');
const LiveOffer = require('../models/LiveOffer');
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
