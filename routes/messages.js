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
      'client student'
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
  console.log('POST /api/messages/task/:taskId called', {
    taskId: req.params.taskId,
    userId: req.user && req.user.id,
    body: req.body,
  });

  try {
    const { error, value } = messageSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      console.log('Validation error:', error.details);
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const task = await Task.findById(req.params.taskId).select(
      'client student title'
    );
    if (!task) {
      console.log('Task not found for id', req.params.taskId);
      return res.status(404).json({ message: 'Task not found' });
    }

    const userId = req.user.id;
    const isClient = task.client.toString() === userId;
    const isStudent =
      task.student && task.student.toString() === userId;

    if (!isClient && !isStudent) {
      console.log('User not part of task', { userId, taskId: task._id });
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

    // FIX: use a single populate call on the document
    await message.populate([
      { path: 'sender', select: 'name role' },
      { path: 'receiver', select: 'name role' },
    ]);

    console.log('Message created and populated, id:', message._id.toString());

    // Fast success response
    res.status(201).json(message);

    // Fire-and-forget push notification (cannot break the API)
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
        console.error('FCM sendNotification error:', notifyErr);
      }
    })();
  } catch (err) {
    console.error('Error sending message (outer catch):', err);
    res
      .status(500)
      .json({ message: 'Error sending message', error: err.message });
  }
});

module.exports = router;
