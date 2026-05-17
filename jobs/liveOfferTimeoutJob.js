const LiveRequest = require('../models/LiveRequest');
const { routeRequestToNextAgent, STATUS } = require('../services/liveDispatcher');

let timer = null;

function startLiveOfferTimeoutJob() {
  if (timer) return;

  const interval = Number(process.env.LIVE_TIMEOUT_SWEEP_MS || 1500);

  timer = setInterval(async () => {
    try {
      const expired = await LiveRequest.find({
        status: STATUS.OFFERED,
        offerExpiresAt: { $lte: new Date() },
      }).sort({ offerExpiresAt: 1 }).limit(50);

      for (const req of expired) {
        routeRequestToNextAgent(req._id, {
          reason: 'auto_timeout_10_seconds',
          force: true,
        }).catch(console.error);
      }
    } catch (error) {
      console.error('Live offer timeout job failed:', error.message);
    }
  }, interval);

  console.log(`⏱️ Live offer timeout job started (${interval}ms).`);
}

module.exports = { startLiveOfferTimeoutJob };
