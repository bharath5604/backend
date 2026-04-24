// backend/routes/notifications.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Joi = require('joi');

const Notification = require('../models/Notification');
const User = require('../models/User');
const verifyJWT = require('../middleware/authMiddleware');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getUserId(req) {
  return (
    req.user?.id ||
    req.user?._id ||
    req.user?.userId ||
    req.user?.sub ||
    ''
  ).toString().trim();
}

const registerTokenSchema = Joi.object({
  token: Joi.string().min(10).max(500).required(),
});

const unregisterTokenSchema = Joi.object({
  token: Joi.string().min(10).max(500).required(),
});

const markReadSchema = Joi.object({
  ids: Joi.array().items(Joi.string().required()).min(1).required(),
});

router.get('/', verifyJWT, async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(401).json({
        message: 'Valid authenticated user not found',
      });
    }

    const since = clean(req.query.since);
    const unreadOnly =
      String(req.query.unreadOnly || '').toLowerCase() === 'true';
    const limitRaw = Number(req.query.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 100)
        : 50;

    const filter = { user: userId };

    if (since) {
      const date = new Date(since);
      if (!Number.isNaN(date.getTime())) {
        filter.createdAt = { $gt: date };
      }
    }

    if (unreadOnly) {
      filter.isRead = false;
    }

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit);

    const unreadCount = await Notification.countDocuments({
      user: userId,
      isRead: false,
    });

    return res.json({
      notifications,
      unreadCount,
    });
  } catch (err) {
    console.error('Error in GET /api/notifications', err);
    return res.status(500).json({
      message: 'Error fetching notifications',
      error: err.message,
    });
  }
});

router.get('/unread-count', verifyJWT, async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(401).json({
        message: 'Valid authenticated user not found',
      });
    }

    const unreadCount = await Notification.countDocuments({
      user: userId,
      isRead: false,
    });

    return res.json({ unreadCount });
  } catch (err) {
    console.error('Error in GET /api/notifications/unread-count', err);
    return res.status(500).json({
      message: 'Error fetching unread count',
      error: err.message,
    });
  }
});

router.post('/read', verifyJWT, async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(401).json({
        message: 'Valid authenticated user not found',
      });
    }

    const { error, value } = markReadSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const ids = value.ids.map((id) => clean(id)).filter(Boolean);

    if (ids.length === 0) {
      return res.status(400).json({
        message: 'No valid notification IDs provided',
      });
    }

    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));

    if (validIds.length === 0) {
      return res.status(400).json({
        message: 'No valid notification IDs provided',
      });
    }

    const result = await Notification.updateMany(
      { _id: { $in: validIds }, user: userId },
      { $set: { isRead: true } }
    );

    const unreadCount = await Notification.countDocuments({
      user: userId,
      isRead: false,
    });

    return res.json({
      message: 'Marked as read',
      matchedCount: result.matchedCount ?? result.n ?? 0,
      modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
      unreadCount,
    });
  } catch (err) {
    console.error('Error in POST /api/notifications/read', err);
    return res.status(500).json({
      message: 'Error updating notifications',
      error: err.message,
    });
  }
});

router.post('/read-all', verifyJWT, async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(401).json({
        message: 'Valid authenticated user not found',
      });
    }

    const result = await Notification.updateMany(
      { user: userId, isRead: false },
      { $set: { isRead: true } }
    );

    return res.json({
      message: 'All notifications marked as read',
      matchedCount: result.matchedCount ?? result.n ?? 0,
      modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
      unreadCount: 0,
    });
  } catch (err) {
    console.error('Error in POST /api/notifications/read-all', err);
    return res.status(500).json({
      message: 'Error updating notifications',
      error: err.message,
    });
  }
});

router.post('/register-token', verifyJWT, async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(401).json({
        message: 'Valid authenticated user not found',
      });
    }

    const { error, value } = registerTokenSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const token = clean(value.token);

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { fcmToken: token } },
      { new: true }
    ).select('_id fcmToken');

    if (!user) {
      return res.status(404).json({
        message: 'User not found',
      });
    }

    return res.json({
      message: 'Token registered',
      fcmToken: user.fcmToken,
    });
  } catch (err) {
    console.error('Error in POST /api/notifications/register-token', err);
    return res.status(500).json({
      message: 'Error registering token',
      error: err.message,
    });
  }
});

router.post('/unregister-token', verifyJWT, async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(401).json({
        message: 'Valid authenticated user not found',
      });
    }

    const { error, value } = unregisterTokenSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const token = clean(value.token);
    const user = await User.findById(userId).select('fcmToken');

    if (!user) {
      return res.status(404).json({
        message: 'User not found',
      });
    }

    if (user.fcmToken && user.fcmToken === token) {
      user.fcmToken = '';
      await user.save();
    }

    return res.json({
      message: 'Token unregistered',
    });
  } catch (err) {
    console.error('Error in POST /api/notifications/unregister-token', err);
    return res.status(500).json({
      message: 'Error unregistering token',
      error: err.message,
    });
  }
});

module.exports = router;