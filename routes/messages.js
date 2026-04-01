const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const Task = require('../models/Task');
const verifyJWT = require('../middleware/authMiddleware');
const Joi = require('joi');
const { sendNotification } = require('../utils/fcm');

const messageSchema = Joi.object({
  taskId: Joi.string().required(),
  text: Joi.string().min(1).max(2000).allow('', null),
  fileUrl: Joi.string().uri().max(2000).allow('', null),
  fileName: Joi.string().max(255).allow('', null),
  targetRole: Joi.string().valid('client', 'student').required(),
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

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isTaskChatClosed(task) {
  return (
    task.status === 'declined' ||
    task.attemptCount >= (task.maxAttempts || 3)
  );
}

function resolveAdminMediatedAccess(task, user, targetRole = null) {
  const userId = user.id.toString();
  const role = user.role;
  const clientId = task.client?.toString() || null;
  const studentId = task.student?.toString() || null;

  if (!clientId) {
    return { allowed: false, reason: 'Task client is missing', peerId: null };
  }

  if (!studentId && (role === 'student' || targetRole === 'student')) {
    return {
      allowed: false,
      reason: 'No student is assigned to this task yet',
      peerId: null,
    };
  }

  if (role === 'admin') {
    if (!targetRole) {
      return {
        allowed: false,
        reason: 'targetRole is required for admin messages',
        peerId: null,
      };
    }

    if (targetRole === 'client') {
      return { allowed: true, reason: null, peerId: clientId };
    }

    if (targetRole === 'student') {
      if (!studentId) {
        return {
          allowed: false,
          reason: 'No student is assigned to this task yet',
          peerId: null,
        };
      }
      return { allowed: true, reason: null, peerId: studentId };
    }
  }

  if (role === 'client') {
    if (userId !== clientId) {
      return { allowed: false, reason: 'Not your task', peerId: null };
    }
    return { allowed: true, reason: null, peerId: null };
  }

  if (role === 'student') {
    if (!studentId || userId !== studentId) {
      return {
        allowed: false,
        reason: 'You are not assigned to this task',
        peerId: null,
      };
    }
    return { allowed: true, reason: null, peerId: null };
  }

  return { allowed: false, reason: 'Unauthorized role', peerId: null };
}

// GET /api/messages/task?taskId=...
// Admin sees all task messages.
// Client sees only messages where admin is sender/receiver and client is sender/receiver.
// Student sees only messages where admin is sender/receiver and student is sender/receiver.
router.get('/task', verifyJWT, async (req, res) => {
  try {
    const taskId = clean(req.query.taskId);

    if (!taskId) {
      return res.status(400).json({ message: 'taskId is required' });
    }

    const task = await Task.findById(taskId).select(
      'client student title status attemptCount maxAttempts'
    );

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (isTaskChatClosed(task)) {
      return res.status(403).json({
        message: 'Chat is closed for this task',
      });
    }

    const access = resolveAdminMediatedAccess(task, req.user);
    if (!access.allowed) {
      return res.status(403).json({ message: access.reason });
    }

    let filter = { task: task._id };

    if (req.user.role === 'client') {
      filter.$or = [
        { sender: req.user.id },
        { receiver: req.user.id },
      ];
    } else if (req.user.role === 'student') {
      filter.$or = [
        { sender: req.user.id },
        { receiver: req.user.id },
      ];
    }

    const messages = await Message.find(filter)
      .sort({ createdAt: 1 })
      .populate('sender', 'name role')
      .populate('receiver', 'name role');

    return res.json(messages);
  } catch (err) {
    console.error('Error fetching messages:', err);
    return res.status(500).json({
      message: 'Error fetching messages',
      error: err.message,
    });
  }
});

// POST /api/messages/task
// Admin body: { taskId, targetRole: 'client'|'student', text?, fileUrl?, fileName? }
// Client/student body: { taskId, targetRole: 'admin', text?, fileUrl?, fileName? } on frontend,
// but backend ignores targetRole for non-admin and always routes to admin.
router.post('/task', verifyJWT, async (req, res) => {
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

    const taskId = clean(value.taskId);

    if (!taskId) {
      return res.status(400).json({ message: 'taskId is required' });
    }

    const task = await Task.findById(taskId).select(
      'client student title status attemptCount maxAttempts'
    );

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (isTaskChatClosed(task)) {
      return res.status(403).json({
        message: 'Chat is closed for this task',
      });
    }

    let receiverId = null;

    if (req.user.role === 'admin') {
      const access = resolveAdminMediatedAccess(task, req.user, value.targetRole);
      if (!access.allowed) {
        return res.status(403).json({ message: access.reason });
      }
      receiverId = access.peerId;
    } else if (req.user.role === 'client' || req.user.role === 'student') {
      const access = resolveAdminMediatedAccess(task, req.user);
      if (!access.allowed) {
        return res.status(403).json({ message: access.reason });
      }

      const adminUser = await require('../models/User').findOne({ role: 'admin' }).select('_id');
      if (!adminUser) {
        return res.status(500).json({ message: 'No admin available for chat' });
      }
      receiverId = adminUser._id;
    } else {
      return res.status(403).json({ message: 'Unauthorized role' });
    }

    const trimmedText = clean(value.text);
    const trimmedFileUrl = clean(value.fileUrl);
    const trimmedFileName = clean(value.fileName);

    const message = await Message.create({
      task: task._id,
      sender: req.user.id,
      receiver: receiverId,
      student: task.student || null,
      text: trimmedText || undefined,
      fileUrl: trimmedFileUrl || undefined,
      fileName: trimmedFileName || undefined,
    });

    await message.populate([
      { path: 'sender', select: 'name role' },
      { path: 'receiver', select: 'name role' },
    ]);

    res.status(201).json(message);

    (async () => {
      try {
        const notificationBody =
          trimmedText && trimmedText.length > 0
            ? trimmedText.length > 50
              ? `${trimmedText.substring(0, 47)}...`
              : trimmedText
            : trimmedFileName
            ? `Attachment: ${trimmedFileName}`
            : 'New message';

        await sendNotification(receiverId, {
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
    console.error('Error sending message:', err);
    return res.status(500).json({
      message: 'Error sending message',
      error: err.message,
    });
  }
});

module.exports = router;