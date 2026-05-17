let ioRef = null;

function setLiveIO(io) {
  ioRef = io;
}

function getLiveIO() {
  return ioRef;
}

function emitToLiveAgent(agent, event, payload) {
  if (!ioRef || !agent) return;
  const ids = [agent._id, agent.employeeId].filter(Boolean).map(String);
  ids.forEach(id => ioRef.to(`live_agent:${id}`).emit(event, payload));
}

function emitToLiveStudent(userId, event, payload) {
  if (!ioRef || !userId) return;
  ioRef.to(`live_student:${String(userId)}`).emit(event, payload);
}

function emitToLiveAdmin(event, payload) {
  if (!ioRef) return;
  ioRef.to('live_admin').emit(event, payload);
}

module.exports = {
  setLiveIO,
  getLiveIO,
  emitToLiveAgent,
  emitToLiveStudent,
  emitToLiveAdmin,
};
