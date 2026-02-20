// routes/messages.js
const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const Task = require('../models/Task');
const verifyJWT = require('../middleware/authMiddleware');
const Joi = require('joi');
const { sendNotification } = require('../utils/fcm');

const messageSchema = Joi.object({
  text: Joi.string().min(1).max(2000).allow('', null),
  fileUrl: Joi.string().uri().max(2000).allow('', null),
  fileName: Joi.string().max(255).allow('', null),
})
  .custom((value, helpers) => {
    const hasText =
      typeof value.text === 'string' && value.text.trim().length > 0;
    const hasFileUrl =
      typeof value.fileUrl === 'string' && value.fileUrl.trim().length > 0;

    if (!hasText && !hasFileUrl) {
      return helpers.error('any.custom');
    }
    return value;
  }, 'text or file validation')
  .messages({
    'any.custom': 'Message must have either text or a file attachment',
  });

// GET /api/messages/task/:taskId
// List messages between client & assigned student for this task
router.get('/task/:taskId', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId).select(
      'client student status attemptCount maxAttempts'
    );
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Stop chat after approval or after max attempts / hard decline
    if (
      task.status === 'completed' ||
      task.status === 'declined' ||
      task.attemptCount >= (task.maxAttempts || 3)
    ) {
      return res.status(403).json({
        message: 'Conversation closed for this task',
      });
    }

    // Enforce: chat only after acceptance (student assigned & task assigned)
    if (!task.student || task.status !== 'assigned') {
      return res.status(403).json({
        message:
          'Chat is available only after a bid is accepted for this task',
      });
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
      'client student title status attemptCount maxAttempts'
    );
    if (!task) {
      console.log('Task not found for id', req.params.taskId);
      return res.status(404).json({ message: 'Task not found' });
    }

    // Block sending messages after approval / final decline / 3 attempts
    if (
      task.status === 'completed' ||
      task.status === 'declined' ||
      task.attemptCount >= (task.maxAttempts || 3)
    ) {
      return res.status(403).json({
        message: 'Conversation closed for this task',
      });
    }

    // Enforce: chat only after acceptance (student assigned & task assigned)
    if (!task.student || task.status !== 'assigned') {
      return res.status(403).json({
        message:
          'Chat is available only after a bid is accepted for this task',
      });
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

    const trimmedText =
      typeof value.text === 'string' ? value.text.trim() : '';
    const trimmedFileUrl =
      typeof value.fileUrl === 'string' ? value.fileUrl.trim() : '';
    const trimmedFileName =
      typeof value.fileName === 'string' ? value.fileName.trim() : '';

    const message = await Message.create({
      task: task._id,
      sender: userId,
      receiver,
      text: trimmedText || undefined,
      fileUrl: trimmedFileUrl || undefined,
      fileName: trimmedFileName || undefined,
    });

    await message.populate([
      { path: 'sender', select: 'name role' },
      { path: 'receiver', select: 'name role' },
    ]);

    console.log('Message created and populated, id:', message._id.toString());

    res.status(201).json(message);

    (async () => {
      try {
        const notificationBody =
          trimmedText && trimmedText.length > 0
            ? trimmedText.length > 50
              ? trimmedText.substring(0, 47) + '...'
              : trimmedText
            : trimmedFileName
            ? `Attachment: ${trimmedFileName}`
            : 'New message';

        await sendNotification(receiver, {
          title: 'New message',
          body: notificationBody,
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
