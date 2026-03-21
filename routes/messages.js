// routes/messages.js
const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const Task = require('../models/Task');
const TaskRequest = require('../models/TaskRequest');
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

// helper: check if user is allowed to chat on this task
async function checkChatPermission(task, userId) {
  const isClient = task.client.toString() === userId;
  const isAssignedStudent =
    task.student && task.student.toString() === userId;

  // If task is formally assigned, only client + assigned student can chat
  if (task.student) {
    return { allowed: isClient || isAssignedStudent, isClient, peerId: null };
  }

  // If no assigned student yet, allow:
  // - client: can chat with any accepted-request student (peer decided on client side)
  // - student: can chat if they have an accepted TaskRequest for this task
  if (isClient) {
    // For the client, we just say "allowed"; actual peerId will be chosen per message
    return { allowed: true, isClient: true, peerId: null };
  }

  // Student: must have accepted request
  const hasAcceptedRequest = await TaskRequest.exists({
    task: task._id,
    student: userId,
    status: 'accepted',
  });

  if (!hasAcceptedRequest) {
    return { allowed: false, isClient: false, peerId: null };
  }

  return { allowed: true, isClient: false, peerId: task.client };
}

// GET /api/messages/task/:taskId
// List messages between client & student for this task
router.get('/task/:taskId', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId).select(
      'client student status attemptCount maxAttempts'
    );
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const userId = req.user.id;

    const permission = await checkChatPermission(task, userId);
    if (!permission.allowed) {
      return res.status(403).json({
        message:
          'Chat is available only for the client and students who are part of this task',
      });
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

    const userId = req.user.id;
    const permission = await checkChatPermission(task, userId);
    if (!permission.allowed) {
      return res.status(403).json({
        message:
          'Chat is available only for the client and students who are part of this task',
      });
    }

    const isClient = permission.isClient;
    let receiver;

    if (task.student) {
      // Assigned flow: always between client and assigned student
      receiver = isClient ? task.student : task.client;
    } else {
      // Request flow before final selection:
      // - if sender is student, receiver is client
      // - if sender is client, you may need a specific student; for now we
      //   send messages back to the first accepted student is not defined,
      //   but in your UI you'll usually open chat from a specific student.
      if (isClient) {
        // For safety, require client to specify studentId in body when not assigned
        const { studentId } = req.body;
        if (!studentId) {
          return res.status(400).json({
            message:
              'studentId is required when task is not yet assigned and client is sending a message',
          });
        }
        receiver = studentId;
      } else {
        receiver = task.client;
      }
    }

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