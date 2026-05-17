const admin = require('firebase-admin');
const { mirrorFirestoreRequest, STATUS } = require('../services/liveDispatcher');
const LiveRequest = require('../models/LiveRequest');

let unsub = null;

function startFirestoreLiveBridge() {
  if (process.env.ENABLE_FIRESTORE_LIVE_BRIDGE !== 'true') {
    console.log('ℹ️ Firestore live bridge disabled. Set ENABLE_FIRESTORE_LIVE_BRIDGE=true to enable.');
    return;
  }

  if (!admin.apps?.length) {
    console.log('⚠️ Firestore live bridge skipped: Firebase Admin not initialized.');
    return;
  }

  if (unsub) return;

  const db = admin.firestore();

  unsub = db.collection('Live_Form_Requests')
    .where('status', '==', 'Searching')
    .onSnapshot(async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== 'added' && change.type !== 'modified') continue;

        const firebaseRequestId = change.doc.id;
        const data = change.doc.data() || {};

        // If already mirrored, no need to create duplicate.
        const existing = await LiveRequest.findOne({ firebaseRequestId });
        if (existing && [STATUS.OFFERED, STATUS.ACCEPTED, STATUS.COMPLETED].includes(existing.status)) continue;

        await mirrorFirestoreRequest(firebaseRequestId, data).catch((err) => {
          console.error('Firestore live bridge mirror failed:', err.message);
        });
      }
    }, (error) => {
      console.error('Firestore live bridge listener failed:', error.message);
    });

  console.log('🌉 Firestore live bridge started for Live_Form_Requests.');
}

module.exports = { startFirestoreLiveBridge };
