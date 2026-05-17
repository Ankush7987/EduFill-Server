const crypto = require('crypto');
const admin = require('firebase-admin');
const LiveAgent = require('../models/LiveAgent');
const LiveRequest = require('../models/LiveRequest');
const LiveOffer = require('../models/LiveOffer');
const LiveRequestEvent = require('../models/LiveRequestEvent');
const {
  emitToLiveAgent,
  emitToLiveStudent,
  emitToLiveAdmin,
} = require('./liveSocketHub');

const STATUS = LiveRequest.STATUS;
const OFFER_MS = Number(process.env.LIVE_OFFER_SECONDS || 10) * 1000;
const HEARTBEAT_SECONDS = Number(process.env.AGENT_HEARTBEAT_SECONDS || 35);

function nowDate() {
  return new Date();
}

function normalId(v) {
  return v ? String(v) : '';
}

function offerIsActive(request) {
  return (
    request &&
    request.status === STATUS.OFFERED &&
    request.offerAgentId &&
    request.offerExpiresAt &&
    new Date(request.offerExpiresAt).getTime() > Date.now()
  );
}

function offerPayload(agent) {
  const started = nowDate();
  const expires = new Date(started.getTime() + OFFER_MS);
  return {
    status: STATUS.OFFERED,
    offerAgentId: agent._id,
    offerAgentEmployeeId: agent.employeeId || String(agent._id),
    offerAgentName: agent.name,
    offerStartedAt: started,
    offerExpiresAt: expires,
    offerToken: `${agent._id}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`,
    noAgentAvailable: false,
    routingStatus: 'offered',
    lastRoutingAt: started,
  };
}

function clearOfferPayload(extra = {}) {
  return {
    ...extra,
    offerAgentId: null,
    offerAgentEmployeeId: null,
    offerAgentName: null,
    offerStartedAt: null,
    offerExpiresAt: null,
    offerToken: null,
  };
}

function hasDocs(docs = {}) {
  return Object.values(docs || {}).some(Boolean);
}

async function logEvent(request, type, meta = {}, agent = null) {
  try {
    await LiveRequestEvent.create({
      requestId: request?._id,
      firebaseRequestId: request?.firebaseRequestId,
      type,
      agentId: agent?._id || null,
      agentEmployeeId: agent?.employeeId || null,
      userId: request?.userId || request?.firebaseUserId || null,
      meta,
    });
  } catch (err) {
    console.error('Live event log failed:', err.message);
  }
}

async function syncFirestoreLiveRequest(request, updates = {}) {
  if (!request?.firebaseRequestId) return;
  if (!admin.apps?.length) return;

  try {
    const db = admin.firestore();
    await db.collection('Live_Form_Requests').doc(request.firebaseRequestId).set({
      backendRequestId: String(request._id),
      ...updates,
    }, { merge: true });
  } catch (err) {
    console.warn('Firestore live request sync failed:', err.message);
  }
}

async function upsertFirestoreOtherStudent(request, agent, applicationNumber = null) {
  if (!request?.firebaseRequestId || !admin.apps?.length) return null;

  try {
    const db = admin.firestore();
    const col = db.collection('Other_Students');

    const existing = await col.where('liveRequestId', '==', request.firebaseRequestId).limit(1).get();
    const payload = {
      fullName: request.name,
      mobile: request.mobile,
      exam: request.exam,
      institute: 'Online Student (Website)',
      category: 'General',
      status: request.status,
      paymentStatus: 'Due',
      photoDelivered: false,
      confirmationDelivered: false,
      assignedTo: agent?.name || request.acceptedAgentName || 'EduFill Expert',
      liveRequestId: request.firebaseRequestId,
      backendRequestId: String(request._id),
      userId: request.firebaseUserId || request.userId || null,
      userEmail: request.userEmail || '',
      documents: request.documents || {},
      vaultDocuments: request.vaultDocuments || {},
      vaultUserId: request.firebaseUserId || request.userId || null,
      documentSource: hasDocs(request.documents || request.vaultDocuments || {}) ? 'vault' : null,
      applicationNumber: applicationNumber || request.applicationNumber || 'N/A',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (existing.empty) {
      const docRef = await col.add({
        ...payload,
        tokenNumber: `WEB-${Math.floor(100000 + Math.random() * 900000)}`,
        slotDate: new Date().toISOString().slice(0, 10),
        slotTime: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      return docRef.id;
    }

    const docRef = existing.docs[0].ref;
    await docRef.set(payload, { merge: true });
    return docRef.id;
  } catch (err) {
    console.warn('Firestore Other_Students sync failed:', err.message);
    return null;
  }
}

async function pickNextAgent(request) {
  const staleBefore = new Date(Date.now() - HEARTBEAT_SECONDS * 1000);
  const skippedMongoIds = (request.skippedAgentIds || []).map(normalId);
  const skippedEmployeeIds = (request.skippedEmployeeIds || []).map(normalId);

  const query = {
    agentType: 'online',
    active: true,
    isLiveOnline: true,
    liveStatus: 'online',
    isBusy: false,
    onBreak: { $ne: true },
    // In production heartbeat keeps this fresh. In local/dev, allow recently synced
    // online agents even if heartbeat timer is delayed, so requests don't get stuck.
    $or: [
      { lastHeartbeatAt: { $gte: staleBefore } },
      { lastLiveOfferAt: { $gte: staleBefore } },
    ],
    _id: { $nin: skippedMongoIds },
    $and: [
      {
        $or: [
          { employeeId: { $exists: false } },
          { employeeId: { $nin: skippedEmployeeIds } },
        ],
      },
      {
        $or: [
          { skills: request.exam },
          { skills: 'ALL' },
          { skills: { $exists: false } },
          { skills: { $size: 0 } },
        ],
      },
    ],
  };

  return LiveAgent.findOne(query)
    .sort({
      assignedCount: 1,
      todayAcceptedCount: 1,
      lastLiveOfferAt: 1,
      completionRate: -1,
      avgResponseMs: 1,
      name: 1,
    });
}

async function routeRequestToNextAgent(requestId, options = {}) {
  const reason = options.reason || 'dispatch';
  const force = Boolean(options.force);
  const skipAgentId = options.skipAgentId || null;
  const skipEmployeeId = options.skipEmployeeId || null;
  const skipAgentName = options.skipAgentName || null;

  const request = await LiveRequest.findById(requestId);
  if (!request) return null;

  if (![STATUS.SEARCHING, STATUS.OFFERED].includes(request.status)) return null;
  if (offerIsActive(request) && !force) return request;

  if (skipAgentId || skipEmployeeId || skipAgentName) {
    if (skipAgentId && !request.skippedAgentIds.map(normalId).includes(normalId(skipAgentId))) {
      request.skippedAgentIds.push(skipAgentId);
    }
    if (skipEmployeeId && !request.skippedEmployeeIds.includes(normalId(skipEmployeeId))) {
      request.skippedEmployeeIds.push(normalId(skipEmployeeId));
    }
    if (skipAgentName && !request.skippedAgentNames.includes(skipAgentName)) {
      request.skippedAgentNames.push(skipAgentName);
    }

    await LiveOffer.updateMany(
      {
        requestId: request._id,
        $or: [
          { agentId: skipAgentId },
          { agentEmployeeId: skipEmployeeId },
        ],
        status: 'Sent',
      },
      { $set: { status: 'Skipped', respondedAt: nowDate(), reason } }
    );

    if (skipAgentId || skipEmployeeId) {
      await LiveAgent.updateOne(
        skipAgentId ? { _id: skipAgentId } : { employeeId: skipEmployeeId },
        { $inc: { skipCount: 1 }, $set: { isBusy: false, currentLiveRequestId: null } }
      );
    }

    await logEvent(request, 'OFFER_SKIPPED', { reason }, { _id: skipAgentId, employeeId: skipEmployeeId, name: skipAgentName });
  } else if (request.status === STATUS.OFFERED && request.offerAgentId) {
    // Expired offer: previous agent goes into skipped list.
    if (!request.skippedAgentIds.map(normalId).includes(normalId(request.offerAgentId))) {
      request.skippedAgentIds.push(request.offerAgentId);
    }
    if (request.offerAgentEmployeeId && !request.skippedEmployeeIds.includes(request.offerAgentEmployeeId)) {
      request.skippedEmployeeIds.push(request.offerAgentEmployeeId);
    }
    if (request.offerAgentName && !request.skippedAgentNames.includes(request.offerAgentName)) {
      request.skippedAgentNames.push(request.offerAgentName);
    }

    await LiveOffer.updateMany(
      { requestId: request._id, agentId: request.offerAgentId, status: 'Sent' },
      { $set: { status: 'Timed Out', respondedAt: nowDate(), reason } }
    );

    await LiveAgent.updateOne(
      { _id: request.offerAgentId },
      { $inc: { skipCount: 1 }, $set: { isBusy: false, currentLiveRequestId: null } }
    );

    await logEvent(request, 'OFFER_TIMED_OUT', { reason }, { _id: request.offerAgentId, employeeId: request.offerAgentEmployeeId, name: request.offerAgentName });
  }

  request.status = STATUS.SEARCHING;
  Object.assign(request, clearOfferPayload({
    noAgentAvailable: false,
    routingStatus: 'routing',
    lastRoutingAt: nowDate(),
  }));

  const nextAgent = await pickNextAgent(request);

  if (!nextAgent) {
    Object.assign(request, clearOfferPayload({
      status: STATUS.SEARCHING,
      noAgentAvailable: true,
      routingStatus: 'waiting_for_online_agent',
      lastRoutingAt: nowDate(),
    }));
    await request.save();

    await syncFirestoreLiveRequest(request, {
      status: 'Searching',
      routingStatus: 'waiting_for_online_agent',
      noAgentAvailable: true,
      agentId: null,
      agentName: null,
    });

    await logEvent(request, 'NO_AGENT_AVAILABLE', { reason });
    emitToLiveAdmin('live:no_agent_available', { requestId: request._id, firebaseRequestId: request.firebaseRequestId });
    return request;
  }

  const payload = offerPayload(nextAgent);

  // Atomic guard: only route if still searching/offered and no fresh active offer.
  const routed = await LiveRequest.findOneAndUpdate(
    {
      _id: request._id,
      status: { $in: [STATUS.SEARCHING, STATUS.OFFERED] },
      $or: [
        { offerExpiresAt: null },
        { offerExpiresAt: { $lte: new Date() } },
        { offerAgentId: null },
        ...(force ? [{}] : []),
      ],
    },
    {
      $set: {
        ...payload,
        skippedAgentIds: request.skippedAgentIds,
        skippedEmployeeIds: request.skippedEmployeeIds,
        skippedAgentNames: request.skippedAgentNames,
      },
    },
    { returnDocument: 'after' }
  );

  if (!routed) return null;

  await LiveAgent.updateOne(
    { _id: nextAgent._id },
    { $set: { lastLiveOfferAt: nowDate(), lastHeartbeatAt: nowDate() } }
  );

  await LiveOffer.create({
    requestId: routed._id,
    firebaseRequestId: routed.firebaseRequestId,
    agentId: nextAgent._id,
    agentEmployeeId: nextAgent.employeeId || String(nextAgent._id),
    agentName: nextAgent.name,
    status: 'Sent',
    expiresAt: routed.offerExpiresAt,
    reason,
  });

  await syncFirestoreLiveRequest(routed, {
    status: 'Searching',
    routingStatus: 'offered',
    offerAgentId: String(nextAgent._id),
    offerAgentEmployeeId: nextAgent.employeeId || String(nextAgent._id),
    offerAgentName: nextAgent.name,
    offerExpiresAt: routed.offerExpiresAt,
    noAgentAvailable: false,
    agentId: null,
    agentName: null,
  });

  await logEvent(routed, 'OFFER_SENT', { reason, expiresAt: routed.offerExpiresAt }, nextAgent);

  const offerData = {
    requestId: String(routed._id),
    firebaseRequestId: routed.firebaseRequestId,
    name: routed.name,
    mobile: routed.mobile,
    exam: routed.exam,
    documents: routed.documents,
    vaultDocuments: routed.vaultDocuments,
    expiresAt: routed.offerExpiresAt,
    offerSeconds: Math.ceil((new Date(routed.offerExpiresAt).getTime() - Date.now()) / 1000),
  };

  emitToLiveAgent(nextAgent, 'live:offer_new', offerData);
  emitToLiveAdmin('live:request_routed', {
    requestId: String(routed._id),
    firebaseRequestId: routed.firebaseRequestId,
    agentId: String(nextAgent._id),
    agentEmployeeId: nextAgent.employeeId,
    agentName: nextAgent.name,
  });
  emitToLiveStudent(routed.firebaseUserId || routed.userId, 'live:request_searching', {
    requestId: String(routed._id),
    firebaseRequestId: routed.firebaseRequestId,
  });

  return routed;
}

async function acceptRequest({ requestId, firebaseRequestId, agentId, employeeId }) {
  const agent = await LiveAgent.findOne(agentId ? { _id: agentId } : { employeeId });
  if (!agent) throw new Error('Agent not found.');
  if (!agent.isLiveOnline || agent.isBusy || agent.onBreak || agent.active === false) {
    throw new Error('Agent is not available.');
  }

  const filter = {
    status: STATUS.OFFERED,
    offerExpiresAt: { $gt: new Date() },
    $or: [
      { offerAgentId: agent._id },
      { offerAgentEmployeeId: agent.employeeId || String(agent._id) },
    ],
  };

  if (requestId) filter._id = requestId;
  if (firebaseRequestId) filter.firebaseRequestId = firebaseRequestId;

  const request = await LiveRequest.findOneAndUpdate(
    filter,
    {
      $set: {
        status: STATUS.ACCEPTED,
        acceptedAgentId: agent._id,
        acceptedAgentEmployeeId: agent.employeeId || String(agent._id),
        acceptedAgentName: agent.name,
        acceptedAt: nowDate(),
        applicationNumber: null,
        completedAt: null,
        completedByAgentId: null,
        completedByAgentName: null,
        routingStatus: 'accepted',
      },
      $unset: {
        offerAgentId: 1,
        offerAgentEmployeeId: 1,
        offerAgentName: 1,
        offerStartedAt: 1,
        offerExpiresAt: 1,
        offerToken: 1,
      },
    },
    { returnDocument: 'after' }
  );

  if (!request) throw new Error('Offer expired or already handled.');

  await LiveOffer.updateMany(
    { requestId: request._id, agentId: agent._id, status: 'Sent' },
    { $set: { status: 'Accepted', respondedAt: nowDate() } }
  );

  await LiveAgent.updateOne(
    { _id: agent._id },
    {
      $set: { isBusy: true, currentLiveRequestId: request._id, lastHeartbeatAt: nowDate() },
      $inc: { assignedCount: 1, todayAcceptedCount: 1 },
    }
  );

  await syncFirestoreLiveRequest(request, {
    status: 'Accepted',
    agentId: agent.employeeId || String(agent._id),
    agentName: agent.name,
    agentPhone: agent.phone || '',
    acceptedAt: admin.apps?.length ? admin.firestore.FieldValue.serverTimestamp() : new Date(),
    completed: false,
    isCompleted: false,
    completedAt: null,
  });

  await upsertFirestoreOtherStudent(request, agent);

  await logEvent(request, 'REQUEST_ACCEPTED', {}, agent);

  emitToLiveStudent(request.firebaseUserId || request.userId, 'live:request_accepted', {
    requestId: String(request._id),
    firebaseRequestId: request.firebaseRequestId,
    agentName: agent.name,
    agentPhone: agent.phone || '',
    status: 'Accepted',
  });

  emitToLiveAgent(agent, 'live:request_accepted', {
    requestId: String(request._id),
    firebaseRequestId: request.firebaseRequestId,
    chatRoomId: request.firebaseRequestId || String(request._id),
  });

  emitToLiveAdmin('live:request_accepted', {
    requestId: String(request._id),
    agentName: agent.name,
  });

  return request;
}

async function skipRequest({ requestId, firebaseRequestId, agentId, employeeId, reason = 'manual_skip' }) {
  const agent = await LiveAgent.findOne(agentId ? { _id: agentId } : { employeeId });
  if (!agent) throw new Error('Agent not found.');

  const request = await LiveRequest.findOne({
    ...(requestId ? { _id: requestId } : {}),
    ...(firebaseRequestId ? { firebaseRequestId } : {}),
    status: STATUS.OFFERED,
    $or: [
      { offerAgentId: agent._id },
      { offerAgentEmployeeId: agent.employeeId || String(agent._id) },
    ],
  });

  if (!request) throw new Error('Offer no longer available.');

  return routeRequestToNextAgent(request._id, {
    force: true,
    reason,
    skipAgentId: agent._id,
    skipEmployeeId: agent.employeeId || String(agent._id),
    skipAgentName: agent.name,
  });
}

async function completeRequest({ requestId, firebaseRequestId, agentId, employeeId, applicationNumber, legacySafe = false }) {
  const agent = await LiveAgent.findOne(agentId ? { _id: agentId } : { employeeId });
  if (!agent) throw new Error('Agent not found.');

  const baseCompletePayload = {
    status: STATUS.COMPLETED,
    applicationNumber: applicationNumber || 'N/A',
    completedAt: nowDate(),
    completedByAgentId: agent._id,
    completedByAgentName: agent.name,
    routingStatus: 'completed',
  };

  const assignedFilter = {
    status: { $in: [STATUS.ACCEPTED, STATUS.IN_PROGRESS] },
    $or: [
      { acceptedAgentId: agent._id },
      { acceptedAgentEmployeeId: agent.employeeId || String(agent._id) },
    ],
  };

  if (requestId) assignedFilter._id = requestId;
  if (firebaseRequestId) assignedFilter.firebaseRequestId = firebaseRequestId;

  let request = await LiveRequest.findOneAndUpdate(
    assignedFilter,
    { $set: baseCompletePayload },
    { returnDocument: 'after' }
  );

  // Legacy safety:
  // Old forms can be stuck in Firestore/admin queue, while Mongo request may be missing
  // or not linked to the same acceptedAgentId. In that case complete by request id/firebase id
  // and unblock the agent instead of keeping the whole flow stuck.
  if (!request && legacySafe && (requestId || firebaseRequestId)) {
    const legacyFilter = {
      status: { $in: [STATUS.SEARCHING, STATUS.OFFERED, STATUS.ACCEPTED, STATUS.IN_PROGRESS] },
    };
    if (requestId) legacyFilter._id = requestId;
    if (firebaseRequestId) legacyFilter.firebaseRequestId = firebaseRequestId;

    request = await LiveRequest.findOneAndUpdate(
      legacyFilter,
      {
        $set: {
          ...baseCompletePayload,
          acceptedAgentId: agent._id,
          acceptedAgentEmployeeId: agent.employeeId || String(agent._id),
          acceptedAgentName: agent.name,
          acceptedAt: nowDate(),
        },
        $unset: {
          offerAgentId: 1,
          offerAgentEmployeeId: 1,
          offerAgentName: 1,
          offerStartedAt: 1,
          offerExpiresAt: 1,
          offerToken: 1,
        },
      },
      { returnDocument: 'after' }
    );
  }

  if (!request) {
    if (legacySafe) {
      await unblockAgent({
        agentId,
        employeeId,
        requestId,
        firebaseRequestId,
        applicationNumber,
        keepOnline: true,
      });

      return {
        legacyOnly: true,
        status: STATUS.COMPLETED,
        requestId: requestId || null,
        firebaseRequestId: firebaseRequestId || null,
        applicationNumber: applicationNumber || 'N/A',
      };
    }

    throw new Error('Request not assigned to this agent or already completed.');
  }

  await LiveAgent.updateOne(
    { _id: agent._id },
    {
      $set: { isBusy: false, currentLiveRequestId: null, lastHeartbeatAt: nowDate() },
      $inc: { todayCompletedCount: 1 },
    }
  );

  await syncFirestoreLiveRequest(request, {
    status: 'Completed',
    applicationNumber: request.applicationNumber,
    completedAt: admin.apps?.length ? admin.firestore.FieldValue.serverTimestamp() : new Date(),
    completedBy: agent.name,
    completed: true,
    isCompleted: true,
  });

  await upsertFirestoreOtherStudent(request, agent, request.applicationNumber);

  await logEvent(request, 'REQUEST_COMPLETED', { applicationNumber: request.applicationNumber, legacySafe }, agent);

  emitToLiveStudent(request.firebaseUserId || request.userId, 'live:request_completed', {
    requestId: String(request._id),
    firebaseRequestId: request.firebaseRequestId,
    applicationNumber: request.applicationNumber,
    status: 'Completed',
  });

  emitToLiveAgent(agent, 'live:request_completed', {
    requestId: String(request._id),
    firebaseRequestId: request.firebaseRequestId,
  });

  emitToLiveAdmin('live:request_completed', {
    requestId: String(request._id),
    agentName: agent.name,
  });

  // Free agent: immediately route next waiting request.
  const waiting = await LiveRequest.findOne({ status: STATUS.SEARCHING, offerAgentId: null }).sort({ createdAt: 1 });
  if (waiting) routeRequestToNextAgent(waiting._id, { reason: 'agent_freed' }).catch(console.error);

  return request;
}

async function unblockAgent({ agentId, employeeId, requestId = null, firebaseRequestId = null, applicationNumber = 'N/A', keepOnline = true }) {
  const agent = await LiveAgent.findOne(agentId ? { _id: agentId } : { employeeId });
  if (!agent) throw new Error('Agent not found.');

  // Complete matching legacy request if it exists, but do not fail if it does not.
  const requestFilter = {};
  if (requestId) requestFilter._id = requestId;
  if (firebaseRequestId) requestFilter.firebaseRequestId = firebaseRequestId;

  let request = null;
  if (requestId || firebaseRequestId) {
    request = await LiveRequest.findOneAndUpdate(
      {
        ...requestFilter,
        status: { $in: [STATUS.SEARCHING, STATUS.OFFERED, STATUS.ACCEPTED, STATUS.IN_PROGRESS] },
      },
      {
        $set: {
          status: STATUS.COMPLETED,
          applicationNumber: applicationNumber || 'N/A',
          completedAt: nowDate(),
          completedByAgentId: agent._id,
          completedByAgentName: agent.name,
          routingStatus: 'completed_legacy_unblock',
        },
        $unset: {
          offerAgentId: 1,
          offerAgentEmployeeId: 1,
          offerAgentName: 1,
          offerStartedAt: 1,
          offerExpiresAt: 1,
          offerToken: 1,
        },
      },
      { returnDocument: 'after' }
    );

    if (request) {
      await syncFirestoreLiveRequest(request, {
        status: 'Completed',
        applicationNumber: request.applicationNumber || applicationNumber || 'N/A',
        completedAt: admin.apps?.length ? admin.firestore.FieldValue.serverTimestamp() : new Date(),
        completedBy: agent.name,
        completed: true,
        isCompleted: true,
      }).catch(() => {});
    }
  }

  const agentUpdate = {
    isBusy: false,
    currentLiveRequestId: null,
    lastHeartbeatAt: nowDate(),
  };

  if (keepOnline) {
    agentUpdate.isLiveOnline = true;
    agentUpdate.liveStatus = 'online';
    agentUpdate.agentType = 'online';
  }

  await LiveAgent.updateOne({ _id: agent._id }, { $set: agentUpdate });

  await logEvent(
    request || { _id: requestId || firebaseRequestId || agent._id, userId: null },
    'AGENT_UNBLOCKED',
    { requestId, firebaseRequestId, applicationNumber, keepOnline },
    agent
  ).catch(() => {});

  const waiting = await LiveRequest.findOne({ status: STATUS.SEARCHING, offerAgentId: null }).sort({ createdAt: 1 });
  if (waiting) routeRequestToNextAgent(waiting._id, { reason: 'agent_unblocked' }).catch(console.error);

  emitToLiveAgent(agent, 'live:agent_unblocked', {
    agentId: String(agent._id),
    employeeId: agent.employeeId,
    requestId,
    firebaseRequestId,
  });

  emitToLiveAdmin('live:agent_unblocked', {
    agentId: String(agent._id),
    employeeId: agent.employeeId,
    agentName: agent.name,
  });

  return {
    agent: {
      id: String(agent._id),
      employeeId: agent.employeeId,
      name: agent.name,
      isBusy: false,
      isLiveOnline: keepOnline,
    },
    request,
  };
}


async function mirrorFirestoreRequest(firebaseRequestId, data = {}) {
  if (!firebaseRequestId) return null;

  const docs = data.documents || data.vaultDocuments || {};
  const payload = {
    firebaseRequestId,
    firebaseUserId: data.userId || data.uid || data.vaultUserId || '',
    userId: data.userId || data.uid || data.vaultUserId || '',
    userEmail: data.userEmail || data.email || '',
    userPhone: data.userPhone || data.mobile || '',
    name: data.name || data.fullName || 'Student',
    mobile: data.mobile || data.phone || 'N/A',
    exam: data.exam || 'N/A',
    documents: data.documents || docs || {},
    vaultDocuments: data.vaultDocuments || docs || {},
    hasUploadedDocuments: hasDocs(data.documents || data.vaultDocuments || {}),
    status: data.status === 'Accepted' ? STATUS.ACCEPTED : data.status === 'Completed' ? STATUS.COMPLETED : STATUS.SEARCHING,
  };

  const existing = await LiveRequest.findOneAndUpdate(
    { firebaseRequestId },
    { $setOnInsert: payload },
    { upsert: true, returnDocument: 'after' }
  );

  if ([STATUS.SEARCHING, STATUS.OFFERED].includes(existing.status) && !offerIsActive(existing)) {
    routeRequestToNextAgent(existing._id, { reason: 'firestore_bridge_new_request' }).catch(console.error);
  }

  return existing;
}

module.exports = {
  STATUS,
  routeRequestToNextAgent,
  acceptRequest,
  skipRequest,
  completeRequest,
  unblockAgent,
  mirrorFirestoreRequest,
  syncFirestoreLiveRequest,
};
