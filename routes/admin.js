// backend/routes/admin.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Joi = require('joi');

const User = require('../models/User');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const Message = require('../models/Message');

const verifyJWT = require('../middleware/authMiddleware');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeId(value) {
  return clean(value);
}

function toObjectIdString(value) {
  if (!value) return '';

  if (typeof value === 'string') {
    return value.trim();
  }

  if (value instanceof mongoose.Types.ObjectId) {
    return value.toString();
  }

  if (typeof value === 'object' && value._id) {
    if (value._id instanceof mongoose.Types.ObjectId) {
      return value._id.toString();
    }
    return String(value._id).trim();
  }

  return String(value).trim();
}

function isValidObjectId(value) {
  if (!value) return false;
  if (!mongoose.Types.ObjectId.isValid(value)) return false;
  return String(new mongoose.Types.ObjectId(value)) === String(value);
}

const ensureAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      message: 'Admin only',
    });
  }
  next();
};

const approveUserSchema = Joi.object({
  isApproved: Joi.boolean().required(),
});

const adminTaskFilterSchema = Joi.object({
  company: Joi.string().allow('', null),
  location: Joi.string().allow('', null),
  domain: Joi.string().allow('', null),
  status: Joi.string()
    .valid('open', 'assigned', 'under_review', 'completed', 'declined')
    .allow('', null),
  assignmentStatus: Joi.string()
    .valid(
      'unassigned',
      'request_sent',
      'accepted',
      'rejected',
      'cancelled',
      'expired'
    )
    .allow('', null),
});

const assignStudentSchema = Joi.object({
  studentId: Joi.string().required(),
});

const paymentStatusSchema = Joi.object({
  status: Joi.string()
    .valid('created', 'held', 'completed', 'cancelled')
    .required(),
  adminNote: Joi.string().max(2000).allow('', null),
});

const adminMessageSchema = Joi.object({
  text: Joi.string().allow('', null),
  fileUrl: Joi.string().uri().allow('', null),
  fileName: Joi.string().allow('', null),
  studentId: Joi.string().allow('', null),
});

function taskSupportsAssignmentRequest(task) {
  return (
    task &&
    Object.prototype.hasOwnProperty.call(task.toObject?.() || task, 'assignmentStatus')
  );
}

// =========================================================
// USERS
// =========================================================

router.get('/users', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const role = clean(req.query.role);
    const company = clean(req.query.company);
    const location = clean(req.query.location);
    const domain = clean(req.query.domain);

    const filter = {};
    if (role) filter.role = role;
    if (company) filter.company = company;
    if (location) filter.location = location;
    if (domain) filter.domain = domain;

    const users = await User.find(filter).select('-password');
    return res.json(users);
  } catch (err) {
    console.error('Error in /api/admin/users', err);
    return res.status(500).json({
      message: 'Error loading users',
      error: err.message,
    });
  }
});

router.patch(
  '/users/:id/approve',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { error, value } = approveUserSchema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      if (error) {
        return res.status(400).json({
          message: 'Validation error',
          details: error.details.map((d) => d.message),
        });
      }

      const id = normalizeId(req.params.id);
      if (!id || !isValidObjectId(id)) {
        return res.status(400).json({ message: 'Valid user ID is required' });
      }

      const user = await User.findByIdAndUpdate(
        id,
        { isApproved: value.isApproved },
        { new: true, runValidators: true }
      ).select('-password');

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      return res.json({
        message: 'Approval updated',
        user,
      });
    } catch (err) {
      console.error('Error in PATCH /api/admin/users/:id/approve', err);
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

// =========================================================
// TASKS
// =========================================================

router.get('/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { error, value } = adminTaskFilterSchema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const filter = {};
    if (clean(value.company)) filter.company = clean(value.company);
    if (clean(value.location)) filter.location = clean(value.location);
    if (clean(value.domain)) filter.domain = clean(value.domain);
    if (clean(value.status)) filter.status = clean(value.status);
    if (clean(value.assignmentStatus)) {
      filter.assignmentStatus = clean(value.assignmentStatus);
    }

    const tasks = await Task.find(filter)
      .populate('client', 'name email company')
      .populate('student', 'name email skills')
      .populate('assignedByAdmin', 'name email')
      .sort({ createdAt: -1 });

    return res.json(tasks);
  } catch (err) {
    console.error('Error in /api/admin/tasks', err);
    return res.status(500).json({
      message: 'Error loading tasks',
      error: err.message,
    });
  }
});

router.get('/tasks/filters', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [companies, locations, domains, assignmentStatuses] = await Promise.all([
      Task.distinct('company'),
      Task.distinct('location'),
      Task.distinct('domain'),
      Task.distinct('assignmentStatus'),
    ]);

    return res.json({
      companies: companies.filter(Boolean),
      locations: locations.filter(Boolean),
      domains: domains.filter(Boolean),
      assignmentStatuses: assignmentStatuses.filter(Boolean),
    });
  } catch (err) {
    console.error('Error in /api/admin/tasks/filters', err);
    return res.status(500).json({
      message: 'Error loading task filters',
      error: err.message,
    });
  }
});

router.get(
  '/tasks/:id/candidates',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const taskId = normalizeId(req.params.id);
      if (!taskId || !isValidObjectId(taskId)) {
        return res.status(400).json({ message: 'Valid task ID is required' });
      }

      const task = await Task.findById(taskId).select(
        'requiredSkills skills domain status assignmentStatus'
      );

      if (!task) {
        return res.status(404).json({ message: 'Task not found' });
      }

      const match = { role: 'student', isApproved: true };

      const skillPool =
        Array.isArray(task.requiredSkills) && task.requiredSkills.length > 0
          ? task.requiredSkills
          : Array.isArray(task.skills) && task.skills.length > 0
          ? task.skills
          : [];

      if (skillPool.length > 0) {
        match.skills = { $in: skillPool };
      } else if (task.domain) {
        match.domain = task.domain;
      }

      const students = await User.aggregate([
        { $match: match },
        {
          $addFields: {
            averageScore: {
              $cond: [
                { $gt: ['$totalScoreCount', 0] },
                { $divide: ['$totalScore', '$totalScoreCount'] },
                0,
              ],
            },
          },
        },
        { $sort: { averageScore: -1, tasksCompleted: -1, createdAt: -1 } },
        { $limit: 50 },
        {
          $project: {
            name: 1,
            email: 1,
            skills: 1,
            tasksCompleted: 1,
            totalScore: 1,
            totalScoreCount: 1,
            averageScore: 1,
            wallet: 1,
            domain: 1,
          },
        },
      ]);

      return res.json(students);
    } catch (err) {
      console.error('Error in GET /api/admin/tasks/:id/candidates', err);
      return res.status(500).json({
        message: 'Error loading candidates',
        error: err.message,
      });
    }
  }
);

router.post(
  '/tasks/:id/assign',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { error, value } = assignStudentSchema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      if (error) {
        return res.status(400).json({
          message: 'Validation error',
          details: error.details.map((d) => d.message),
        });
      }

      const taskId = normalizeId(req.params.id);
      const studentId = normalizeId(value.studentId);

      if (!taskId || !isValidObjectId(taskId)) {
        return res.status(400).json({ message: 'Valid task ID is required' });
      }

      if (!studentId || !isValidObjectId(studentId)) {
        return res.status(400).json({ message: 'Valid student ID is required' });
      }

      const task = await Task.findById(taskId);

      if (!task) {
        return res.status(404).json({ message: 'Task not found' });
      }

      const supportedRequestFlow = taskSupportsAssignmentRequest(task);

      if (supportedRequestFlow) {
        if (
          task.assignmentStatus &&
          !['unassigned', 'rejected', 'cancelled', 'expired'].includes(task.assignmentStatus)
        ) {
          return res.status(400).json({
            message: `Task cannot be reassigned while assignmentStatus is "${task.assignmentStatus}"`,
          });
        }
      } else {
        if (task.status !== 'open') {
          return res.status(400).json({ message: 'Only open tasks can be assigned' });
        }
      }

      const student = await User.findById(studentId).select(
        'name email role isApproved skills domain'
      );

      if (!student || student.role !== 'student') {
        return res.status(404).json({ message: 'Student not found' });
      }

      if (!student.isApproved) {
        return res.status(400).json({ message: 'Student is not approved' });
      }

      task.student = student._id;
      task.assignedByAdmin = req.user.id;
      task.assignedAt = new Date();

      if (supportedRequestFlow) {
        task.assignmentStatus = 'request_sent';
        task.assignmentRequestedAt = new Date();
        task.assignmentRespondedAt = null;
        task.assignmentAcceptedAt = null;
        task.assignmentRejectedAt = null;
        task.assignmentRejectedReason = '';
        task.status = 'open';
      } else {
        task.status = 'assigned';
      }

      if (
        'attemptCount' in task &&
        (task.attemptCount == null || Number.isNaN(Number(task.attemptCount)))
      ) {
        task.attemptCount = 0;
      }

      await task.save();

      const populatedTask = await Task.findById(task._id)
        .populate('client', 'name email company')
        .populate('student', 'name email skills')
        .populate('assignedByAdmin', 'name email');

      return res.json({
        message: supportedRequestFlow
          ? 'Assignment request sent successfully'
          : 'Student assigned successfully',
        task: populatedTask,
      });
    } catch (err) {
      console.error('Error in POST /api/admin/tasks/:id/assign', err);
      return res.status(500).json({
        message: 'Error assigning student',
        error: err.message,
      });
    }
  }
);

// =========================================================
// ADMIN MESSAGES
// =========================================================

router.get('/tasks/:id/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const taskId = normalizeId(req.params.id);
    const studentId = normalizeId(req.query.studentId);

    if (!taskId || !isValidObjectId(taskId)) {
      return res.status(400).json({ message: 'Valid task ID is required' });
    }

    if (studentId && !isValidObjectId(studentId)) {
      return res.status(400).json({ message: 'Invalid student ID' });
    }

    const task = await Task.findById(taskId).populate(
      'client student',
      '_id name email role'
    );

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const filter = { task: taskId };
    if (studentId) {
      filter.student = studentId;
    }

    const messages = await Message.find(filter)
      .populate('sender', 'name email role')
      .populate('receiver', 'name email role')
      .sort({ createdAt: 1 });

    return res.json(messages);
  } catch (err) {
    console.error('Error in GET /api/admin/tasks/:id/messages', err);
    return res.status(500).json({
      message: 'Error loading task messages',
      error: err.message,
    });
  }
});

router.get(
  '/tasks/:id/chat/client/messages',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const taskId = normalizeId(req.params.id);

      if (!taskId || !isValidObjectId(taskId)) {
        return res.status(400).json({ message: 'Valid task ID is required' });
      }

      const task = await Task.findById(taskId).populate(
        'client student',
        '_id name email role'
      );

      if (!task) {
        return res.status(404).json({ message: 'Task not found' });
      }

      if (!task.client) {
        return res.status(400).json({ message: 'Task has no client' });
      }

      const clientId = toObjectIdString(task.client);
      const adminId = toObjectIdString(req.user.id);

      if (!clientId || !isValidObjectId(clientId)) {
        return res.status(400).json({
          message: 'Valid client ID could not be resolved',
        });
      }

      const messages = await Message.find({
        task: taskId,
        $or: [
          { sender: adminId, receiver: clientId },
          { sender: clientId, receiver: adminId },
        ],
      })
        .populate('sender', 'name email role')
        .populate('receiver', 'name email role')
        .sort({ createdAt: 1 });

      return res.json(messages);
    } catch (err) {
      console.error(
        'Error in GET /api/admin/tasks/:id/chat/client/messages',
        err
      );
      return res.status(500).json({
        message: 'Error loading client chat messages',
        error: err.message,
      });
    }
  }
);

router.post(
  '/tasks/:id/chat/client/messages',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const taskId = normalizeId(req.params.id);

      const { error, value } = adminMessageSchema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      if (error) {
        return res.status(400).json({
          message: 'Validation error',
          details: error.details.map((d) => d.message),
        });
      }

      if (!taskId || !isValidObjectId(taskId)) {
        return res.status(400).json({ message: 'Valid task ID is required' });
      }

      const task = await Task.findById(taskId).populate(
        'client student',
        '_id name email role'
      );

      if (!task) {
        return res.status(404).json({ message: 'Task not found' });
      }

      if (!task.client) {
        return res.status(400).json({ message: 'Task has no client' });
      }

      const clientId = toObjectIdString(task.client);
      if (!clientId || !isValidObjectId(clientId)) {
        return res.status(400).json({
          message: 'Valid client receiver ID could not be resolved',
        });
      }

      const text = clean(value.text);
      const fileUrl = clean(value.fileUrl);
      const fileName = clean(value.fileName);
      const studentId = normalizeId(value.studentId);

      if (!text && !fileUrl) {
        return res.status(400).json({
          message: 'Message text or file is required',
        });
      }

      let studentContext = null;
      if (studentId && isValidObjectId(studentId)) {
        studentContext = studentId;
      } else if (task.student) {
        const resolvedStudentId = toObjectIdString(task.student);
        if (resolvedStudentId && isValidObjectId(resolvedStudentId)) {
          studentContext = resolvedStudentId;
        }
      }

      const message = await Message.create({
        task: taskId,
        sender: req.user.id,
        receiver: clientId,
        student: studentContext || undefined,
        text,
        fileUrl: fileUrl || undefined,
        fileName: fileName || undefined,
      });

      const populated = await Message.findById(message._id)
        .populate('sender', 'name email role')
        .populate('receiver', 'name email role');

      return res.status(201).json(populated);
    } catch (err) {
      console.error(
        'Error in POST /api/admin/tasks/:id/chat/client/messages',
        err
      );
      return res.status(500).json({
        message: 'Error sending client chat message',
        error: err.message,
      });
    }
  }
);

router.get(
  '/tasks/:id/chat/student/messages',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const taskId = normalizeId(req.params.id);
      const requestedStudentId = normalizeId(req.query.studentId);

      if (!taskId || !isValidObjectId(taskId)) {
        return res.status(400).json({ message: 'Valid task ID is required' });
      }

      if (requestedStudentId && !isValidObjectId(requestedStudentId)) {
        return res.status(400).json({ message: 'Invalid student ID' });
      }

      const task = await Task.findById(taskId).populate(
        'client student',
        '_id name email role'
      );

      if (!task) {
        return res.status(404).json({ message: 'Task not found' });
      }

      const studentId = requestedStudentId || toObjectIdString(task.student);

      if (!studentId || !isValidObjectId(studentId)) {
        return res.status(400).json({
          message: 'Student ID is required for student chat',
        });
      }

      const adminId = toObjectIdString(req.user.id);

      const messages = await Message.find({
        task: taskId,
        student: studentId,
        $or: [
          { sender: adminId, receiver: studentId },
          { sender: studentId, receiver: adminId },
        ],
      })
        .populate('sender', 'name email role')
        .populate('receiver', 'name email role')
        .sort({ createdAt: 1 });

      return res.json(messages);
    } catch (err) {
      console.error(
        'Error in GET /api/admin/tasks/:id/chat/student/messages',
        err
      );
      return res.status(500).json({
        message: 'Error loading student chat messages',
        error: err.message,
      });
    }
  }
);

router.post(
  '/tasks/:id/chat/student/messages',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const taskId = normalizeId(req.params.id);

      const { error, value } = adminMessageSchema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      if (error) {
        return res.status(400).json({
          message: 'Validation error',
          details: error.details.map((d) => d.message),
        });
      }

      if (!taskId || !isValidObjectId(taskId)) {
        return res.status(400).json({ message: 'Valid task ID is required' });
      }

      const task = await Task.findById(taskId).populate(
        'client student',
        '_id name email role'
      );

      if (!task) {
        return res.status(404).json({ message: 'Task not found' });
      }

      const studentId =
        normalizeId(value.studentId) || toObjectIdString(task.student);

      if (!studentId || !isValidObjectId(studentId)) {
        return res.status(400).json({
          message: 'Student ID is required for student chat',
        });
      }

      const text = clean(value.text);
      const fileUrl = clean(value.fileUrl);
      const fileName = clean(value.fileName);

      if (!text && !fileUrl) {
        return res.status(400).json({
          message: 'Message text or file is required',
        });
      }

      const message = await Message.create({
        task: taskId,
        sender: req.user.id,
        receiver: studentId,
        student: studentId,
        text,
        fileUrl: fileUrl || undefined,
        fileName: fileName || undefined,
      });

      const populated = await Message.findById(message._id)
        .populate('sender', 'name email role')
        .populate('receiver', 'name email role');

      return res.status(201).json(populated);
    } catch (err) {
      console.error(
        'Error in POST /api/admin/tasks/:id/chat/student/messages',
        err
      );
      return res.status(500).json({
        message: 'Error sending student chat message',
        error: err.message,
      });
    }
  }
);

router.post('/tasks/:id/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const taskId = normalizeId(req.params.id);

    const { error, value } = adminMessageSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    if (!taskId || !isValidObjectId(taskId)) {
      return res.status(400).json({ message: 'Valid task ID is required' });
    }

    const task = await Task.findById(taskId).populate(
      'client student',
      '_id name email role'
    );

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const text = clean(value.text);
    const fileUrl = clean(value.fileUrl);
    const fileName = clean(value.fileName);
    const studentId = normalizeId(value.studentId);

    if (!text && !fileUrl) {
      return res.status(400).json({
        message: 'Message text or file is required',
      });
    }

    let receiverId = '';
    if (studentId && isValidObjectId(studentId)) {
      receiverId = studentId;
    } else if (task.student) {
      receiverId = toObjectIdString(task.student);
    }

    if (!receiverId || !isValidObjectId(receiverId)) {
      return res.status(400).json({
        message: 'Valid receiver student ID is required',
      });
    }

    const payload = {
      task: taskId,
      sender: req.user.id,
      receiver: receiverId,
      student: receiverId,
      text,
      fileUrl: fileUrl || undefined,
      fileName: fileName || undefined,
    };

    const message = await Message.create(payload);

    const populated = await Message.findById(message._id)
      .populate('sender', 'name email role')
      .populate('receiver', 'name email role');

    return res.status(201).json(populated);
  } catch (err) {
    console.error('Error in POST /api/admin/tasks/:id/messages', err);
    return res.status(500).json({
      message: 'Error sending message',
      error: err.message,
    });
  }
});

// =========================================================
// DASHBOARD / STATS / PAYMENTS
// =========================================================

router.get('/stats/overview', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [
      totalUsers,
      totalClients,
      totalStudents,
      totalTasks,
      openTasks,
      assignedTasks,
      underReviewTasks,
      completedTasks,
      declinedTasks,
      totalPayments,
      pendingPayments,
      completedPayments,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: 'client' }),
      User.countDocuments({ role: 'student' }),
      Task.countDocuments({}),
      Task.countDocuments({ status: 'open' }),
      Task.countDocuments({ status: 'assigned' }),
      Task.countDocuments({ status: 'under_review' }),
      Task.countDocuments({ status: 'completed' }),
      Task.countDocuments({ status: 'declined' }),
      Payment.countDocuments({}),
      Payment.countDocuments({ status: { $in: ['created', 'held'] } }),
      Payment.countDocuments({ status: 'completed' }),
    ]);

    const [totalPayoutAmount, completedPayoutAmount, heldPayoutAmount] =
      await Promise.all([
        Payment.aggregate([
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        Payment.aggregate([
          { $match: { status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        Payment.aggregate([
          { $match: { status: { $in: ['created', 'held'] } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
      ]);

    const safeTotal = (arr) =>
      Array.isArray(arr) && arr.length > 0 ? arr[0].total || 0 : 0;

    return res.json({
      users: {
        total: totalUsers,
        clients: totalClients,
        students: totalStudents,
      },
      tasks: {
        total: totalTasks,
        open: openTasks,
        assigned: assignedTasks,
        underReview: underReviewTasks,
        completed: completedTasks,
        declined: declinedTasks,
      },
      payments: {
        totalCount: totalPayments,
        pendingCount: pendingPayments,
        completedCount: completedPayments,
        totalAmount: safeTotal(totalPayoutAmount),
        completedAmount: safeTotal(completedPayoutAmount),
        heldAmount: safeTotal(heldPayoutAmount),
      },
    });
  } catch (err) {
    console.error('Error in GET /api/admin/stats/overview', err);
    return res.status(500).json({
      message: 'Error loading overview stats',
      error: err.message,
    });
  }
});

router.get('/stats/payments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [byStatus, byStudent] = await Promise.all([
      Payment.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            total: { $sum: '$amount' },
          },
        },
      ]),
      Payment.aggregate([
        {
          $group: {
            _id: '$student',
            count: { $sum: 1 },
            total: { $sum: '$amount' },
          },
        },
        { $sort: { total: -1 } },
        { $limit: 20 },
      ]),
    ]);

    return res.json({
      byStatus,
      byStudent,
    });
  } catch (err) {
    console.error('Error in GET /api/admin/stats/payments', err);
    return res.status(500).json({
      message: 'Error loading payment stats',
      error: err.message,
    });
  }
});

router.get('/payments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const status = clean(req.query.status);
    const filter = {};
    if (status) {
      filter.status = status;
    }

    const payments = await Payment.find(filter)
      .populate('student', 'name email')
      .populate('task', 'title status')
      .sort({ createdAt: -1 });

    return res.json(payments);
  } catch (err) {
    console.error('Error in GET /api/admin/payments', err);
    return res.status(500).json({
      message: 'Error loading payments',
      error: err.message,
    });
  }
});

router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const payments = await Payment.find({
      status: { $in: ['created', 'held'] },
    })
      .populate('student', 'name email')
      .populate('task', 'title status')
      .sort({ createdAt: -1 });

    return res.json(payments);
  } catch (err) {
    console.error('Error in GET /api/admin/getPendingPayments', err);
    return res.status(500).json({
      message: 'Error loading pending payments',
      error: err.message,
    });
  }
});

router.post(
  '/releasePayment/:id',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const paymentId = normalizeId(req.params.id);
      if (!paymentId || !isValidObjectId(paymentId)) {
        return res.status(400).json({ message: 'Valid payment ID is required' });
      }

      const payment = await Payment.findById(paymentId)
        .populate('student', 'name email')
        .populate('task', 'title status');

      if (!payment) {
        return res.status(404).json({ message: 'Payment not found' });
      }

      if (payment.status === 'completed') {
        return res.status(400).json({ message: 'Payment already completed' });
      }
      if (payment.status === 'cancelled') {
        return res.status(400).json({ message: 'Payment is cancelled' });
      }

      payment.status = 'completed';
      payment.releasedByAdmin = req.user.id;
      payment.releasedAt = new Date();

      await payment.save();

      return res.json({
        message: 'Payment released successfully',
        payment,
      });
    } catch (err) {
      console.error('Error in POST /api/admin/releasePayment/:id', err);
      return res.status(500).json({
        message: 'Error releasing payment',
        error: err.message,
      });
    }
  }
);

router.get('/getTaskStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const byStatus = await Task.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    const byCompany = await Task.aggregate([
      { $match: { company: { $ne: null } } },
      {
        $group: {
          _id: '$company',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]);

    return res.json({
      byStatus,
      byCompany,
    });
  } catch (err) {
    console.error('Error in GET /api/admin/getTaskStats', err);
    return res.status(500).json({
      message: 'Error loading task stats',
      error: err.message,
    });
  }
});

router.get('/getDomainStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const tasksByDomain = await Task.aggregate([
      { $match: { domain: { $ne: null } } },
      {
        $group: {
          _id: '$domain',
          tasks: { $sum: 1 },
        },
      },
      { $sort: { tasks: -1 } },
    ]);

    const studentsByDomain = await User.aggregate([
      { $match: { role: 'student', domain: { $ne: null } } },
      {
        $group: {
          _id: '$domain',
          students: { $sum: 1 },
        },
      },
      { $sort: { students: -1 } },
    ]);

    return res.json({
      tasksByDomain,
      studentsByDomain,
    });
  } catch (err) {
    console.error('Error in GET /api/admin/getDomainStats', err);
    return res.status(500).json({
      message: 'Error loading domain stats',
      error: err.message,
    });
  }
});

router.get('/getTopStudents', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const topStudents = await User.aggregate([
      { $match: { role: 'student', isApproved: true } },
      {
        $addFields: {
          averageScore: {
            $cond: [
              { $gt: ['$totalScoreCount', 0] },
              { $divide: ['$totalScore', '$totalScoreCount'] },
              0,
            ],
          },
        },
      },
      {
        $project: {
          name: 1,
          email: 1,
          tasksCompleted: 1,
          totalScore: 1,
          totalScoreCount: 1,
          averageScore: 1,
          domain: 1,
          wallet: 1,
        },
      },
      {
        $sort: {
          averageScore: -1,
          tasksCompleted: -1,
          createdAt: -1,
        },
      },
      { $limit: 20 },
    ]);

    return res.json(topStudents);
  } catch (err) {
    console.error('Error in GET /api/admin/getTopStudents', err);
    return res.status(500).json({
      message: 'Error loading top students',
      error: err.message,
    });
  }
});

router.get('/getTimeSeriesStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 90);

    const tasksTimeSeries = await Task.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: {
          '_id.year': 1,
          '_id.month': 1,
          '_id.day': 1,
        },
      },
    ]);

    const paymentsTimeSeries = await Payment.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' },
          },
          count: { $sum: 1 },
          total: { $sum: '$amount' },
        },
      },
      {
        $sort: {
          '_id.year': 1,
          '_id.month': 1,
          '_id.day': 1,
        },
      },
    ]);

    return res.json({
      tasks: tasksTimeSeries,
      payments: paymentsTimeSeries,
    });
  } catch (err) {
    console.error('Error in GET /api/admin/getTimeSeriesStats', err);
    return res.status(500).json({
      message: 'Error loading time series stats',
      error: err.message,
    });
  }
});

router.get('/getTaskFunnelStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const funnel = await Task.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    return res.json({
      funnel,
    });
  } catch (err) {
    console.error('Error in GET /api/admin/getTaskFunnelStats', err);
    return res.status(500).json({
      message: 'Error loading task funnel stats',
      error: err.message,
    });
  }
});

router.get('/stats/growth', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const metric = clean(req.query.metric) || 'tasks';
    const granularity = clean(req.query.granularity) || 'month';
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : new Date();

    if (from && Number.isNaN(from.getTime())) {
      return res.status(400).json({ message: 'Invalid from date' });
    }
    if (Number.isNaN(to.getTime())) {
      return res.status(400).json({ message: 'Invalid to date' });
    }

    const match = {};
    if (from) {
      match.createdAt = { $gte: from, $lte: to };
    } else {
      match.createdAt = { $lte: to };
    }

    const dateProjection = (() => {
      if (granularity === 'day') {
        return {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' },
        };
      }
      if (granularity === 'week') {
        return {
          year: { $year: '$createdAt' },
          week: { $isoWeek: '$createdAt' },
        };
      }
      return {
        year: { $year: '$createdAt' },
        month: { $month: '$createdAt' },
      };
    })();

    let collection;
    if (metric === 'students') {
      collection = User;
      match.role = 'student';
    } else if (metric === 'payments') {
      collection = Payment;
    } else {
      collection = Task;
    }

    const growth = await collection.aggregate([
      { $match: match },
      {
        $group: {
          _id: dateProjection,
          count: { $sum: 1 },
        },
      },
      {
        $sort: {
          '_id.year': 1,
          '_id.month': 1,
          '_id.week': 1,
          '_id.day': 1,
        },
      },
    ]);

    return res.json(growth);
  } catch (err) {
    console.error('Error in GET /api/admin/stats/growth', err);
    return res.status(500).json({
      message: 'Error loading growth stats',
      error: err.message,
    });
  }
});

module.exports = router;