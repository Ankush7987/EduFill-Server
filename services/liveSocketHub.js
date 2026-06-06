let ioRef = null;

const safeString = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const uniqueIds = (values = []) => {
  return [...new Set(values.map(safeString).filter(Boolean))];
};

function setLiveIO(io) {
  if (!io) {
    console.warn('[liveSocketHub] setLiveIO called without io instance');
    return;
  }

  ioRef = io;
  console.log('[liveSocketHub] Socket.IO instance registered');
}

function getLiveIO() {
  return ioRef;
}

function isIOReady() {
  return Boolean(ioRef);
}

function emitToRoom(room, event, payload = {}) {
  const cleanRoom = safeString(room);

  if (!ioRef) {
    console.warn(`[liveSocketHub] Cannot emit "${event}" because ioRef is not ready`);
    return false;
  }

  if (!cleanRoom || !event) {
    console.warn('[liveSocketHub] Invalid room/event:', { room, event });
    return false;
  }

  ioRef.to(cleanRoom).emit(event, payload);
  return true;
}

function emitToLiveAgent(agent, event, payload = {}) {
  if (!agent) return false;

  const ids = uniqueIds([
    agent._id,
    agent.id,
    agent.employeeId,
    agent.agentId,
  ]);

  if (!ids.length) {
    console.warn('[liveSocketHub] Agent emit skipped: no valid agent id found');
    return false;
  }

  let emitted = false;

  ids.forEach((id) => {
    const ok = emitToRoom(`live_agent:${id}`, event, payload);
    if (ok) emitted = true;
  });

  return emitted;
}

function emitToLiveAgentId(agentId, event, payload = {}) {
  const id = safeString(agentId);
  if (!id) return false;

  return emitToRoom(`live_agent:${id}`, event, payload);
}

function emitToLiveStudent(userId, event, payload = {}) {
  const id = safeString(userId);
  if (!id) return false;

  return emitToRoom(`live_student:${id}`, event, payload);
}

function emitToLiveAdmin(event, payload = {}) {
  return emitToRoom('live_admin', event, payload);
}

function emitToLiveRequest(requestId, event, payload = {}) {
  const id = safeString(requestId);
  if (!id) return false;

  return emitToRoom(`live_request:${id}`, event, payload);
}

function emitToChatRoom(roomId, event, payload = {}) {
  const id = safeString(roomId);
  if (!id) return false;

  return emitToRoom(id, event, payload);
}

module.exports = {
  setLiveIO,
  getLiveIO,
  isIOReady,
  emitToRoom,
  emitToLiveAgent,
  emitToLiveAgentId,
  emitToLiveStudent,
  emitToLiveAdmin,
  emitToLiveRequest,
  emitToChatRoom,
};