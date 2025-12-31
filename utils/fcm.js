const admin = require('firebase-admin');
const Notification = require('../models/Notification');
const User = require('../models/User');

let fcmReady = false;

try {
  if (!admin.apps.length && process.env.FCM_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    fcmReady = true;
    console.log('FCM initialized');
  } else if (!process.env.FCM_SERVICE_ACCOUNT_JSON) {
    console.warn('FCM_SERVICE_ACCOUNT_JSON not set; push notifications disabled');
  }
} catch (err) {
  console.error('Failed to init Firebase Admin for FCM:', err.message);
  fcmReady = false;
}

/**
 * Send notification to a user:
 * - Always creates a Notification document.
 * - Tries FCM push only if Firebase Admin is configured and user has fcmToken.
 */
async function sendNotification(userId, { title, body, data = {} }) {
  // Always create DB notification
  const notif = await Notification.create({ user: userId, title, body, data });

  // Try to send push only if FCM is configured
  if (!fcmReady) {
    return notif;
  }

  const user = await User.findById(userId).select('fcmToken');
  if (!user || !user.fcmToken) {
    return notif;
  }

  const payloadData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v ?? '')])
  );

  try {
    await admin.messaging().send({
      token: user.fcmToken,
      notification: { title, body },
      data: payloadData,
    });
  } catch (err) {
    console.error('FCM send error:', err.message);
  }

  return notif;
}

module.exports = { sendNotification };
