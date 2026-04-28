// backend/routes/messages.js
const express = require('express');
const router = express.Router();
const Joi = require('joi');
const mongoose = require('mongoose');

const Message = require('../models/Message');
const Task = require('../models/Task');
const User = require('../models/User');
const verifyJWT = require('../middleware/authMiddleware');
const { sendNotification } = require('../utils/fcm');

// =========================================================
// JOI SCHEMAS
// =========================================================

const messageSchema = Joi.object({
  taskId: Joi.string().required(),
  text: Joi.string().min(1).max(2000).allow('', null),
  fileUrl: Joi.string().uri().max(2000).allow('', null),
  fileName: Joi.string().max(255).allow('', null),
  targetRole: Joi.string().valid('admin', 'client', 'student').required(),
})
  .custom((value, helpers) => {
    const hasText = typeof value.text === 'string' && value.text.trim().length > 0;
    const hasFileUrl = typeof value.fileUrl === 'string' && value.fileUrl.trim().length > 0;
    if (!hasText && !hasFileUrl) return helpers.error('any.custom');
    return value;
  }, 'text or file validation')
  .messages({
    'any.custom': 'Message must have either text or a file attachment',
  });

const adminStudentMessageSchema = Joi.object({
  taskId: Joi.string().required(),
  studentId: Joi.string().required(),
  text: Joi.string().min(1).max(2000).allow('', null),
  fileUrl: Joi.string().uri().max(2000).allow('', null),
  fileName: Joi.string().max(255).allow('', null),
})
  .custom((value, helpers) => {
    const hasText = typeof value.text === 'string' && value.text.trim().length > 0;
    const hasFileUrl = typeof value.fileUrl === 'string' && value.fileUrl.trim().length > 0;
    if (!hasText && !hasFileUrl) return helpers.error('any.custom');
    return value;
  }, 'text or file validation')
  .messages({
    'any.custom': 'Message must have either text or a file attachment',
  });

// =========================================================
// HELPERS
// =========================================================

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

/**
 * FIXED: canAccessTaskChat
 * Now asynchronous. It checks if the student is formally assigned OR if they 
 * are currently being vetted (Admin clicked "Chat First").
 */
async function canAccessTaskChat(task, user) {
  const userId = user.id.toString();
  const role = user.role;
  const { clientId, studentId } = getTaskPartyIds(task);

  if (role === 'admin') return { allowed: true, reason: null };

  if (role === 'client') {
    if (!clientId || userId !== clientId) return { allowed: false, reason: 'Not your task' };
    return { allowed: true, reason: null };
  }

  if (role === 'student') {
    // 1. Check if they are formally assigned or invited
    const isAssigned = studentId && userId === studentId;
    const isInvited = task.requestedStudent && task.requestedStudent.toString() === userId;
    if (isAssigned || isInvited) return { allowed: true, reason: null };

    // 2. Check for Vetting (Chat First): allow if a message exists between them and Admin
    const messageExists = await Message.findOne({
      task: task._id,
      $or: [
        { sender: userId, receiver: { $exists: true } }, 
        { receiver: userId, sender: { $exists: true } }
      ]
    });

    if (messageExists) return { allowed: true, reason: null };

    return { allowed: false, reason: 'You have not been contacted for this task yet.' };
  }

  return { allowed: false, reason: 'Unauthorized role' };
}

async function resolveReceiverForMessage(task, user, targetRole) {
  const role = user.role;
  const { clientId, studentId } = getTaskPartyIds(task);

  if (role === 'admin') {
    if (targetRole === 'client') {
      if (!clientId) return { ok: false, status: 400, message: 'Task client is missing' };
      return { ok: true, receiverId: clientId };
    }

    if (targetRole === 'student') {
      // In vetting stage, studentId might be missing from task. Use specific student route logic instead.
      if (!studentId) return { ok: false, status: 400, message: 'No student is assigned yet' };
      return { ok: true, receiverId: studentId };
    }
    return { ok: false, status: 400, message: 'Admin targetRole must be client or student' };
  }

  if (role === 'client' || role === 'student') {
    const access = await canAccessTaskChat(task, user);
    if (!access.allowed) return { ok: false, status: 403, message: access.reason };

    const adminUser = await User.findOne({ role: 'admin' }).select('_id');
    if (!adminUser) return { ok: false, status: 500, message: 'No admin available for chat' };

    return { ok: true, receiverId: adminUser._id.toString() };
  }

  return { ok: false, status: 403, message: 'Unauthorized role' };
}

// =========================================================
// ROUTES
// =========================================================

// GET /api/messages/task?taskId=...&studentId=...
router.get('/task', verifyJWT, async (req, res) => {
  try {
    const taskId = normalizeId(req.query.taskId);
    const requestedStudentId = normalizeId(req.query.studentId);

    if (!taskId) return res.status(400).json({ message: 'taskId is required' });

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (isTaskChatClosed(task)) return res.status(403).json({ message: 'Chat is closed' });

    // FIXED: Added await
    const access = await canAccessTaskChat(task, req.user);
    if (!access.allowed) return res.status(403).json({ message: access.reason });

    const filter = { task: task._id };

    if (req.user.role === 'admin') {
      if (requestedStudentId) {
        filter.$or = [{ student: requestedStudentId }, { peerStudentId: requestedStudentId }];
      }
      // If admin and no studentId, they likely want the client thread (legacy support)
    } else if (req.user.role === 'student') {
      // Students only see their own conversation with admin
      filter.$or = [{ sender: req.user.id }, { receiver: req.user.id }];
    } else {
      // Clients only see their own conversation with admin
      filter.$or = [{ sender: req.user.id }, { receiver: req.user.id }];
    }

    const messages = await Message.find(filter)
      .sort({ createdAt: 1 })
      .populate('sender', 'name role')
      .populate('receiver', 'name role');

    return res.json(messages);
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching messages', error: err.message });
  }
});

// POST /api/messages/task
router.post('/task', verifyJWT, async (req, res) => {
  try {
    const { error, value } = messageSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ message: error.details[0].message });

    const taskId = normalizeId(value.taskId);
    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (isTaskChatClosed(task)) return res.status(403).json({ message: 'Chat is closed' });

    // FIXED: Added await
    const receiverResolution = await resolveReceiverForMessage(task, req.user, value.targetRole);
    if (!receiverResolution.ok) return res.status(receiverResolution.status).json({ message: receiverResolution.message });

    const messagePayload = {
      task: task._id,
      sender: req.user.id,
      receiver: receiverResolution.receiverId,
      text: clean(value.text) || undefined,
      fileUrl: clean(value.fileUrl) || undefined,
      fileName: clean(value.fileName) || undefined,
    };

    // Link message to the student thread for grouping
    if (req.user.role === 'student') {
      messagePayload.student = req.user.id;
      messagePayload.peerStudentId = req.user.id;
    } else if (value.targetRole === 'student') {
      messagePayload.student = receiverResolution.receiverId;
      messagePayload.peerStudentId = receiverResolution.receiverId;
    }

    const message = await Message.create(messagePayload);
    await message.populate([{ path: 'sender', select: 'name role' }, { path: 'receiver', select: 'name role' }]);

    res.status(201).json(message);

    // Background Notification
    (async () => {
      try {
        await sendNotification(receiverResolution.receiverId, {
          title: 'New message',
          body: value.text ? (value.text.length > 50 ? value.text.substring(0, 47) + '...' : value.text) : 'Attachment received',
          data: { type: 'chat_message', taskId: task._id.toString() },
        });
      } catch (notifyErr) { console.error('FCM error:', notifyErr); }
    })();
  } catch (err) {
    return res.status(500).json({ message: 'Error sending message', error: err.message });
  }
});

/**
 * ADMIN–STUDENT SPECIFIC THREAD ENDPOINTS
 */

router.get('/admin-student', verifyJWT, async (req, res) => {
  try {
    const taskId = normalizeId(req.query.taskId);
    const studentId = normalizeId(req.query.studentId);

    if (!taskId || !studentId) return res.status(400).json({ message: 'taskId and studentId required' });

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    // Auth check
    const userId = req.user.id.toString();
    if (req.user.role !== 'admin' && userId !== studentId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const filter = {
      task: task._id,
      $or: [
        { student: studentId },
        { peerStudentId: studentId },
        { sender: studentId, receiver: { $exists: true } },
        { receiver: studentId, sender: { $exists: true } }
      ],
    };

    const messages = await Message.find(filter)
      .sort({ createdAt: 1 })
      .populate('sender', 'name role')
      .populate('receiver', 'name role');

    return res.json(messages);
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching messages', error: err.message });
  }
});

router.post('/admin-student', verifyJWT, async (req, res) => {
  try {
    const { error, value } = adminStudentMessageSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ message: error.details[0].message });

    const taskId = normalizeId(value.taskId);
    const studentId = normalizeId(value.studentId);
    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const userId = req.user.id.toString();
    if (req.user.role !== 'admin' && userId !== studentId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    let receiverId = (req.user.role === 'admin') ? studentId : null;
    if (!receiverId) {
      const adminUser = await User.findOne({ role: 'admin' }).select('_id');
      receiverId = adminUser._id.toString();
    }

    const message = await Message.create({
      task: task._id,
      sender: req.user.id,
      receiver: receiverId,
      text: clean(value.text) || undefined,
      fileUrl: clean(value.fileUrl) || undefined,
      fileName: clean(value.fileName) || undefined,
      student: studentId,
      peerStudentId: studentId,
    });

    await message.populate([{ path: 'sender', select: 'name role' }, { path: 'receiver', select: 'name role' }]);
    res.status(201).json(message);

    (async () => {
      try {
        await sendNotification(receiverId, {
          title: 'New message',
          body: value.text || 'Attachment received',
          data: { type: 'chat_message', taskId: task._id.toString(), studentId },
        });
      } catch (notifyErr) { console.error('FCM error:', notifyErr); }
    })();
  } catch (err) {
    return res.status(500).json({ message: 'Error sending message', error: err.message });
  }
});

module.exports = router;