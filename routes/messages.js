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
  // client-side passes this only when task is not yet assigned
  studentId: Joi.string().allow('', null),
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
// extended so that accepted + selected students can chat
async function checkChatPermission(task, userId, studentIdForClient) {
  const isClient = task.client.toString() === userId;
  const isAssignedStudent =
    task.student && task.student.toString() === userId;

  // If task is formally assigned, only client + assigned student can chat
  if (task.student) {
    return {
      allowed: isClient || isAssignedStudent,
      isClient,
      peerId: isClient ? task.student.toString() : task.client.toString(),
      studentId: task.student.toString(),
    };
  }

  // If no assigned student yet:
  // - client: can chat only with a student who has accepted this task
  // - student: can chat if they have an accepted TaskRequest for this task
  if (isClient) {
    if (!studentIdForClient) {
      return { allowed: false, isClient: true, peerId: null, studentId: null };
    }

    const accepted = await TaskRequest.exists({
      task: task._id,
      student: studentIdForClient,
      status: { $in: ['accepted', 'selected'] }, // allow both
    });

    if (!accepted) {
      return { allowed: false, isClient: true, peerId: null, studentId: null };
    }

    return {
      allowed: true,
      isClient: true,
      peerId: studentIdForClient,
      studentId: studentIdForClient,
    };
  }

  // Student: must have accepted (or been selected for) this task
  const hasAcceptedRequest = await TaskRequest.exists({
    task: task._id,
    student: userId,
    status: { $in: ['accepted', 'selected'] }, // allow both
  });

  if (!hasAcceptedRequest) {
    return { allowed: false, isClient: false, peerId: null, studentId: null };
  }

  return {
    allowed: true,
    isClient: false,
    peerId: task.client.toString(),
    studentId: userId,
  };
}

// GET /api/messages/task
// Query: taskId (required), studentId (optional, for pre-assignment client↔student)
router.get('/task', verifyJWT, async (req, res) => {
  try {
    const { taskId, studentId } = req.query;

    if (!taskId) {
      return res.status(400).json({ message: 'taskId is required' });
    }

    const task = await Task.findById(taskId).select(
      'client student status attemptCount maxAttempts'
    );
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const userId = req.user.id;

    const permission = await checkChatPermission(task, userId, studentId || null);
    if (!permission.allowed) {
      return res.status(403).json({
        message:
          'Chat is available only for the client and students who are part of this task',
      });
    }

    const filter = { task: task._id };
    // If pre-assignment, filter by student field as well
    if (!task.student && permission.studentId) {
      filter.student = permission.studentId;
    }

    const messages = await Message.find(filter)
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

// POST /api/messages/task
// Body: { taskId, text?, fileUrl?, fileName?, studentId? }
router.post('/task', verifyJWT, async (req, res) => {
  console.log('POST /api/messages/task called', {
    body: req.body,
    userId: req.user && req.user.id,
  });

  try {
    const { taskId } = req.body;

    if (!taskId) {
      return res.status(400).json({ message: 'taskId is required' });
    }

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

    const task = await Task.findById(taskId).select(
      'client student title status attemptCount maxAttempts'
    );
    if (!task) {
      console.log('Task not found for id', taskId);
      return res.status(404).json({ message: 'Task not found' });
    }

    const userId = req.user.id;
    const studentIdForClient =
      req.user.role === 'client' && value.studentId
        ? value.studentId
        : null;

    const permission = await checkChatPermission(
      task,
      userId,
      studentIdForClient
    );
    if (!permission.allowed) {
      return res.status(403).json({
        message:
          'Chat is available only for the client and students who are part of this task',
      });
    }

    const isClient = permission.isClient;
    const receiver = permission.peerId;
    const studentForMessage = permission.studentId || null;

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
      student: studentForMessage,
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

    // fire-and-forget FCM
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