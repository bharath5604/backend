// routes/notifications.js
const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const User = require('../models/User');
const verifyJWT = require('../middleware/authMiddleware');
const Joi = require('joi');

// Joi schemas
const registerTokenSchema = Joi.object({
  token: Joi.string().min(10).max(500).required(),
});

const markReadSchema = Joi.object({
  ids: Joi.array().items(Joi.string().required()).min(1).required(),
});

// GET /api/notifications?since=<ISO/ts>
router.get('/', verifyJWT, async (req, res) => {
  try {
    const { since } = req.query;
    const filter = { user: req.user.id };

    if (since) {
      const date = new Date(since);
      if (!isNaN(date.getTime())) {
        filter.createdAt = { $gt: date };
      }
    }

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(notifications);
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error fetching notifications', error: err.message });
  }
});

// POST /api/notifications/read  { ids: [] }  mark as read
router.post('/read', verifyJWT, async (req, res) => {
  try {
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

    await Notification.updateMany(
      { _id: { $in: value.ids }, user: req.user.id },
      { $set: { isRead: true } }
    );

    res.json({ message: 'Marked as read' });
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error updating notifications', error: err.message });
  }
});

// POST /api/notifications/register-token
// body: { token: string } – store FCM token on user
router.post('/register-token', verifyJWT, async (req, res) => {
  try {
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

    await User.findByIdAndUpdate(req.user.id, { fcmToken: value.token });

    res.json({ message: 'Token registered' });
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error registering token', error: err.message });
  }
});

module.exports = router;
