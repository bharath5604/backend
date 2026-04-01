const express = require('express');
const router = express.Router();
const Joi = require('joi');

const Message = require('../models/Message');
const Task = require('../models/Task');
const User = require('../models/User');
const verifyJWT = require('../middleware/authMiddleware');
const { sendNotification } = require('../utils/fcm');

const messageSchema = Joi.object({
  taskId: Joi.string().required(),
  text: Joi.string().min(1).max(2000).allow('', null),
  fileUrl: Joi.string().uri().max(2000).allow('', null),
  fileName: Joi.string().max(255).allow('', null),
  targetRole: Joi.string().valid('admin', 'client', 'student').required(),
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

function normalizeId(value) {
  return clean(value);
}

function isTaskChatClosed(task) {
  return task.status === 'declined';
}

function getTaskPartyIds(task) {
  return {
    clientId: task.client ? task.client.toString() : null,
    studentId: task.student ? task.student.toString() : null,
  };
}

function canAccessTaskChat(task, user) {
  const userId = user.id.toString();
  const role = user.role;
  const { clientId, studentId } = getTaskPartyIds(task);

  if (role === 'admin') {
    return { allowed: true, reason: null };
  }

  if (role === 'client') {
    if (!clientId || userId !== clientId) {
      return { allowed: false, reason: 'Not your task' };
    }
    return { allowed: true, reason: null };
  }

  if (role === 'student') {
    if (!studentId || userId !== studentId) {
      return { allowed: false, reason: 'You are not assigned to this task' };
    }
    return { allowed: true, reason: null };
  }

  return { allowed: false, reason: 'Unauthorized role' };
}

async function resolveReceiverForMessage(task, user, targetRole) {
  const role = user.role;
  const { clientId, studentId } = getTaskPartyIds(task);

  if (role === 'admin') {
    if (targetRole === 'client') {
      if (!clientId) {
        return { ok: false, status: 400, message: 'Task client is missing' };
      }
      return { ok: true, receiverId: clientId };
    }

    if (targetRole === 'student') {
      if (!studentId) {
        return {
          ok: false,
          status: 400,
          message: 'No student is assigned to this task yet',
        };
      }
      return { ok: true, receiverId: studentId };
    }

    return {
      ok: false,
      status: 400,
      message: 'Admin targetRole must be client or student',
    };
  }

  if (role === 'client' || role === 'student') {
    const access = canAccessTaskChat(task, user);
    if (!access.allowed) {
      return { ok: false, status: 403, message: access.reason };
    }

    const adminUser = await User.findOne({ role: 'admin' }).select('_id');
    if (!adminUser) {
      return { ok: false, status: 500, message: 'No admin available for chat' };
    }

    return { ok: true, receiverId: adminUser._id.toString() };
  }

  return { ok: false, status: 403, message: 'Unauthorized role' };
}

// GET /api/messages/task?taskId=...&studentId=...
router.get('/task', verifyJWT, async (req, res) => {
  try {
    const taskId = normalizeId(req.query.taskId);
    const requestedStudentId = normalizeId(req.query.studentId);

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

    const access = canAccessTaskChat(task, req.user);
    if (!access.allowed) {
      return res.status(403).json({ message: access.reason });
    }

    const filter = { task: task._id };

    if (req.user.role === 'admin') {
      if (requestedStudentId) {
        filter.$or = [
          { student: requestedStudentId },
          { peerStudentId: requestedStudentId },
        ];
      }
    } else {
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

    const taskId = normalizeId(value.taskId);

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

    const receiverResolution = await resolveReceiverForMessage(
      task,
      req.user,
      value.targetRole
    );

    if (!receiverResolution.ok) {
      return res.status(receiverResolution.status).json({
        message: receiverResolution.message,
      });
    }

    const trimmedText = clean(value.text);
    const trimmedFileUrl = clean(value.fileUrl);
    const trimmedFileName = clean(value.fileName);

    const messagePayload = {
      task: task._id,
      sender: req.user.id,
      receiver: receiverResolution.receiverId,
      text: trimmedText || undefined,
      fileUrl: trimmedFileUrl || undefined,
      fileName: trimmedFileName || undefined,
    };

    if (task.student) {
      messagePayload.student = task.student;
      messagePayload.peerStudentId = task.student;
    }

    const message = await Message.create(messagePayload);

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

        await sendNotification(receiverResolution.receiverId, {
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