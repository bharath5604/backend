// routes/messages.js
const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const Task = require('../models/Task');
const verifyJWT = require('../middleware/authMiddleware');
const Joi = require('joi');
const { sendNotification } = require('../utils/fcm');

const messageSchema = Joi.object({
  text: Joi.string().min(1).max(2000).required(),
});

// GET /api/messages/task/:taskId
// List messages between client & assigned student for this task
router.get('/task/:taskId', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId).select(
      'client student' // uses client + student
    );
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const userId = req.user.id;
    const isClient = task.client.toString() === userId;
    const isStudent =
      task.student && task.student.toString() === userId;

    if (!isClient && !isStudent) {
      return res
        .status(403)
        .json({ message: 'You are not part of this task' });
    }

    const messages = await Message.find({ task: task._id })
      .sort({ createdAt: 1 })
      .populate('sender', 'name role')
      .populate('receiver', 'name role');

    res.json(messages);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res
      .status(500)
      .json({ message: 'Error fetching messages', error: err.message });
  }
});

// POST /api/messages/task/:taskId
// Send a message between client & student on this task
router.post('/task/:taskId', verifyJWT, async (req, res) => {
  try {
    const { error, value } = messageSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const task = await Task.findById(req.params.taskId).select(
      'client student title'
    );
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const userId = req.user.id;
    const isClient = task.client.toString() === userId;
    const isStudent =
      task.student && task.student.toString() === userId;

    if (!isClient && !isStudent) {
      return res
        .status(403)
        .json({ message: 'You are not part of this task' });
    }

    const receiver = isClient ? task.student : task.client;

    const message = await Message.create({
      task: task._id,
      sender: userId,
      receiver,
      text: value.text.trim(),
    });

    const populated = await message
      .populate('sender', 'name role')
      .populate('receiver', 'name role');

    // 1) Respond immediately so the client gets a fast success and no 500 from FCM
    res.status(201).json(populated);

    // 2) Fire-and-forget push notification; does not affect API response
    (async () => {
      try {
        await sendNotification(receiver, {
          title: 'New message',
          body:
            value.text.length > 50
              ? value.text.substring(0, 47) + '...'
              : value.text,
          data: {
            type: 'chat_message',
            taskId: task._id.toString(),
          },
        });
      } catch (notifyErr) {
        console.error('FCM sendNotification error:', notifyErr.message);
      }
    })();
  } catch (err) {
    console.error('Error sending message:', err);
    res
      .status(500)
      .json({ message: 'Error sending message', error: err.message });
  }
});

module.exports = router;
