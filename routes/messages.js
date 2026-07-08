// backend/routes/messages.js
const express = require('express');
const router = express.Router();
const Joi = require('joi');
const mongoose = require('mongoose');

const Message = require('../models/Message');
const Task = require('../models/Task');
const User = require('../models/User');
const verifyJWT = require('../middleware/authMiddleware');
const { sendNotification } = require('../utils/fcm'); // Now enhanced with req support

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
  // Logic: Removed attemptCount check. Only block if manually declined.
  return task.status === 'declined' && !task.student;
}

function getTaskPartyIds(task) {
  return {
    clientId: task.client ? task.client.toString() : null,
    studentId: task.student ? task.student.toString() : null,
  };
}

/**
 * Access Control Logic
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
    const isAssigned = studentId && userId === studentId;
    const isInvited = task.requestedStudent && task.requestedStudent.toString() === userId;
    if (isAssigned || isInvited) return { allowed: true, reason: null };

    const messageExists = await Message.findOne({
      task: task._id,
      $or: [{ sender: userId }, { receiver: userId }]
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
      if (!studentId && !task.requestedStudent) return { ok: false, status: 400, message: 'No student assigned/invited' };
      return { ok: true, receiverId: studentId || task.requestedStudent.toString() };
    }
    return { ok: false, status: 400, message: 'Admin targetRole must be client or student' };
  }

  const adminUser = await User.findOne({ role: 'admin' }).select('_id');
  if (!adminUser) return { ok: false, status: 500, message: 'Support unavailable' };
  return { ok: true, receiverId: adminUser._id.toString() };
}

// =========================================================
// ROUTES
// =========================================================

// GET /api/messages/task
router.get('/task', verifyJWT, async (req, res) => {
  try {
    const taskId = normalizeId(req.query.taskId);
    const requestedStudentId = normalizeId(req.query.studentId);
    if (!taskId) return res.status(400).json({ message: 'taskId is required' });

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (isTaskChatClosed(task)) return res.status(403).json({ message: 'Chat is closed' });

    const access = await canAccessTaskChat(task, req.user);
    if (!access.allowed) return res.status(403).json({ message: access.reason });

    await Message.updateMany(
      { task: task._id, receiver: req.user.id },
      { $set: { isRead: true } }
    );

    const filter = { task: task._id };
    if (req.user.role === 'admin') {
      if (requestedStudentId) {
        filter.$or = [{ student: requestedStudentId }, { peerStudentId: requestedStudentId }];
      } else {
        filter.student = null; 
      }
    } else {
      filter.$or = [{ sender: req.user.id }, { receiver: req.user.id }];
    }

    const messages = await Message.find(filter)
      .sort({ createdAt: 1 })
      .populate('sender', 'name role')
      .populate('receiver', 'name role');

    return res.json(messages);
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching messages' });
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

    const receiverResolution = await resolveReceiverForMessage(task, req.user, value.targetRole);
    if (!receiverResolution.ok) return res.status(receiverResolution.status).json({ message: receiverResolution.message });

    const messagePayload = {
      task: task._id,
      sender: req.user.id,
      receiver: receiverResolution.receiverId,
      text: clean(value.text) || undefined,
      fileUrl: clean(value.fileUrl) || undefined,
      fileName: clean(value.fileName) || undefined,
      isRead: false
    };

    if (req.user.role === 'student') {
      messagePayload.student = req.user.id;
    } else if (value.targetRole === 'student') {
      messagePayload.student = receiverResolution.receiverId;
    }

    const message = await Message.create(messagePayload);
    await message.populate([{ path: 'sender', select: 'name role' }, { path: 'receiver', select: 'name role' }]);
    
    // REAL-TIME THREAD EMISSION
    const io = req.app.get('socketio');
    if (io) {
      const targetRoom = message.student 
        ? `${taskId}_student_${message.student}` 
        : `${taskId}_client`;

      io.to(targetRoom).emit('new_message', message); 
      
      // BROADCAST TO RECEIVER PRIVATE ROOM (Refresh Inbox list)
      io.to(receiverResolution.receiverId.toString()).emit('new_message', message);

      io.to(taskId.toString()).emit('task_update', { taskId });
    }

    res.status(201).json(message);

    // MONGODB NOTIFICATION + SOCKET PUSH + FCM
    (async () => {
      try {
        await sendNotification(receiverResolution.receiverId, {
          title: `Message from ${req.user.name}`,
          body: value.text || 'Attachment received',
          data: { type: 'chat_message', taskId: task._id.toString() },
        }, req); // <--- MODIFICATION: Pass req here
      } catch (notifyErr) { console.error('Notification error:', notifyErr); }
    })();
  } catch (err) {
    return res.status(500).json({ message: 'Error sending message' });
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

    await Message.updateMany(
      { task: task._id, receiver: req.user.id, student: studentId },
      { $set: { isRead: true } }
    );

    const filter = { task: task._id, student: studentId };

    const messages = await Message.find(filter)
      .sort({ createdAt: 1 })
      .populate('sender', 'name role')
      .populate('receiver', 'name role');

    return res.json(messages);
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching messages' });
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

    const receiverResolution = await resolveReceiverForMessage(task, req.user, 'student');
    
    const message = await Message.create({
      task: task._id,
      sender: req.user.id,
      receiver: receiverResolution.receiverId,
      text: clean(value.text) || undefined,
      fileUrl: clean(value.fileUrl) || undefined,
      fileName: clean(value.fileName) || undefined,
      student: studentId,
      isRead: false
    });

    await message.populate([{ path: 'sender', select: 'name role' }, { path: 'receiver', select: 'name role' }]);
    
    const io = req.app.get('socketio');
    if (io) {
      io.to(`${taskId}_student_${studentId}`).emit('new_message', message); 
      
      // BROADCAST TO RECEIVER PRIVATE ROOM (Refresh Inbox list)
      io.to(receiverResolution.receiverId.toString()).emit('new_message', message);

      io.to(taskId.toString()).emit('task_update', { taskId });
    }

    res.status(201).json(message);

    // MONGODB NOTIFICATION + SOCKET PUSH + FCM
    (async () => {
      try {
        await sendNotification(receiverResolution.receiverId, {
          title: `New message: ${task.title}`,
          body: value.text || 'Attachment received',
          data: { type: 'chat_message', taskId: task._id.toString(), studentId },
        }, req); // <--- MODIFICATION: Pass req here
      } catch (notifyErr) { console.error('Notification error:', notifyErr); }
    })();
  } catch (err) {
    return res.status(500).json({ message: 'Error sending message' });
  }
});

module.exports = router;