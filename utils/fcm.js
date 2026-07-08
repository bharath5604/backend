// backend/utils/fcm.js
const admin = require('firebase-admin');
const Notification = require('../models/Notification');
const User = require('../models/User');

let fcmReady = false;

function parseServiceAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw || !String(raw).trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('Invalid FCM_SERVICE_ACCOUNT_JSON:', err.message);
    return null;
  }
}

function initializeFirebaseAdmin() {
  try {
    if (admin.apps.length > 0) {
      fcmReady = true;
      return;
    }

    const serviceAccount = parseServiceAccount();
    if (!serviceAccount) {
      console.warn(
        'FCM_SERVICE_ACCOUNT_JSON not set or invalid; push notifications disabled'
      );
      fcmReady = false;
      return;
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    fcmReady = true;
    console.log('FCM initialized');
  } catch (err) {
    console.error('Failed to init Firebase Admin for FCM:', err.message);
    fcmReady = false;
  }
}

initializeFirebaseAdmin();

function sanitizeString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function sanitizeDataPayload(data = {}) {
  const safe = {};

  for (const [key, value] of Object.entries(data || {})) {
    if (!key || typeof key !== 'string') continue;
    safe[key] = value === undefined || value === null ? '' : String(value);
  }

  return safe;
}

function isInvalidTokenError(error) {
  const code = error?.code || error?.errorInfo?.code || '';
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token'
  );
}

async function clearUserFcmToken(userId, token) {
  try {
    await User.updateOne(
      { _id: userId, fcmToken: token },
      { $unset: { fcmToken: 1 } }
    );
  } catch (err) {
    console.error('Failed to clear invalid FCM token:', err.message);
  }
}

/**
 * Send notification to a single user.
 * MODIFIED: Uses MongoDB and Sockets as primary messenger.
 * req: Pass the express 'req' object to enable real-time socket emission.
 */
async function sendNotification(
  userId,
  { title, body, data = {}, imageUrl = '' } = {},
  req = null
) {
  const safeTitle = sanitizeString(title);
  const safeBody = sanitizeString(body);
  const safeData = sanitizeDataPayload(data);
  const safeImageUrl = sanitizeString(imageUrl);

  // 1. STORE IN MONGODB (The Messenger Record)
  const notif = await Notification.create({
    user: userId,
    title: safeTitle,
    body: safeBody,
    data: safeData,
    isRead: false
  });

  // 2. EMIT VIA SOCKETS (Instant Website/App Alert)
  // req.app.get('socketio') retrieves the IO instance from server.js
  const io = req ? req.app.get('socketio') : null;
  if (io) {
    // Send to the user's private ID room
    io.to(userId.toString()).emit('new_notification', notif);
    console.log(`[Socket] Notification sent to user: ${userId}`);
  }

  // 3. SEND VIA FCM (Background Push for Mobile)
  if (!fcmReady) {
    return notif;
  }

  const user = await User.findById(userId).select('fcmToken');
  const token = sanitizeString(user?.fcmToken);

  if (!token) {
    return notif;
  }

  const message = {
    token,
    notification: {
      title: safeTitle,
      body: safeBody,
      ...(safeImageUrl ? { imageUrl: safeImageUrl } : {}),
    },
    data: safeData,
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'default_channel',
      },
    },
    apns: {
      headers: {
        'apns-priority': '10',
      },
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
  };

  try {
    await admin.messaging().send(message);
    console.log(`[FCM] Push delivered to: ${userId}`);
  } catch (err) {
    console.error('FCM send error:', err.message);

    if (isInvalidTokenError(err)) {
      await clearUserFcmToken(userId, token);
    }
  }

  return notif;
}

/**
 * Send the same notification to multiple users.
 * MODIFIED: Emits socket updates for every user ID provided.
 */
async function sendBulkNotification(
  userIds,
  { title, body, data = {}, imageUrl = '' } = {},
  req = null
) {
  const uniqueUserIds = [...new Set((userIds || []).map((id) => String(id)))];
  const safeTitle = sanitizeString(title);
  const safeBody = sanitizeString(body);
  const safeData = sanitizeDataPayload(data);
  const safeImageUrl = sanitizeString(imageUrl);

  if (uniqueUserIds.length === 0) {
    return { notifications: [], successCount: 0, failureCount: 0 };
  }

  // 1. STORE IN MONGODB
  const notificationDocs = uniqueUserIds.map((userId) => ({
    user: userId,
    title: safeTitle,
    body: safeBody,
    data: safeData,
  }));

  const notifications = await Notification.insertMany(notificationDocs);

  // 2. EMIT VIA SOCKETS TO ALL USERS
  const io = req ? req.app.get('socketio') : null;
  if (io) {
    notifications.forEach(notif => {
      io.to(notif.user.toString()).emit('new_notification', notif);
    });
  }

  // 3. FCM MULTICAST Logic
  if (!fcmReady) {
    return {
      notifications,
      successCount: 0,
      failureCount: 0,
    };
  }

  const users = await User.find({
    _id: { $in: uniqueUserIds },
    fcmToken: { $exists: true, $ne: null },
  }).select('_id fcmToken');

  const tokenPairs = users
    .map((user) => ({
      userId: String(user._id),
      token: sanitizeString(user.fcmToken),
    }))
    .filter((item) => item.token);

  if (tokenPairs.length === 0) {
    return { notifications, successCount: 0, failureCount: 0 };
  }

  const tokens = tokenPairs.map((item) => item.token);

  const multicastMessage = {
    tokens,
    notification: {
      title: safeTitle,
      body: safeBody,
      ...(safeImageUrl ? { imageUrl: safeImageUrl } : {}),
    },
    data: safeData,
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'default_channel',
      },
    },
    apns: {
      headers: {
        'apns-priority': '10',
      },
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
  };

  try {
    const response = await admin
      .messaging()
      .sendEachForMulticast(multicastMessage);

    const cleanupPromises = [];

    response.responses.forEach((resp, index) => {
      if (!resp.success && isInvalidTokenError(resp.error)) {
        cleanupPromises.push(
          clearUserFcmToken(tokenPairs[index].userId, tokenPairs[index].token)
        );
      }
    });

    if (cleanupPromises.length > 0) {
      await Promise.allSettled(cleanupPromises);
    }

    return {
      notifications,
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (err) {
    console.error('FCM multicast send error:', err.message);
    return {
      notifications,
      successCount: 0,
      failureCount: tokenPairs.length,
    };
  }
}

module.exports = {
  sendNotification,
  sendBulkNotification,
};