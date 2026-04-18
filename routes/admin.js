// backend/routes/admin.js
const express = require('express');
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

/**
 * ADMIN USERS
 */
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

      const { id } = req.params;

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

/**
 * ADMIN TASKS
 */
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
    const [companies, locations, domains] = await Promise.all([
      Task.distinct('company'),
      Task.distinct('location'),
      Task.distinct('domain'),
    ]);

    return res.json({
      companies: companies.filter(Boolean),
      locations: locations.filter(Boolean),
      domains: domains.filter(Boolean),
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
      const task = await Task.findById(req.params.id).select(
        'requiredSkills skills domain status'
      );

      if (!task) {
        return res.status(404).json({ message: 'Task not found' });
      }

      const match = {
        role: 'student',
        isApproved: true,
      };

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
        {
          $sort: {
            averageScore: -1,
            tasksCompleted: -1,
            createdAt: -1,
          },
        },
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

router.post('/tasks/:id/assign', verifyJWT, ensureAdmin, async (req, res) => {
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

    if (!taskId) {
      return res.status(400).json({ message: 'Task ID is required' });
    }

    if (!studentId) {
      return res.status(400).json({ message: 'Student ID is required' });
    }

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.status !== 'open') {
      return res.status(400).json({
        message: 'Only open tasks can be assigned',
      });
    }

    const student = await User.findById(studentId).select(
      'name email role isApproved skills domain'
    );

    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    if (!student.isApproved) {
      return res.status(400).json({
        message: 'Student is not approved',
      });
    }

    task.student = student._id;
    task.assignedByAdmin = req.user.id;
    task.assignedAt = new Date();
    task.status = 'assigned';

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
      message: 'Student assigned successfully',
      task: populatedTask,
    });
  } catch (err) {
    console.error('Error in POST /api/admin/tasks/:id/assign', err);
    return res.status(500).json({
      message: 'Error assigning student',
      error: err.message,
    });
  }
});

/**
 * ADMIN MESSAGES
 */
router.get(
  '/tasks/:id/messages',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const taskId = normalizeId(req.params.id);
      const studentId = normalizeId(req.query.studentId);

      if (!taskId) {
        return res.status(400).json({ message: 'Task ID is required' });
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
        filter.$or = [{ student: studentId }, { peerStudentId: studentId }];
      }

      const messages = await Message.find(filter)
        .populate('sender', 'name email role')
        .sort({ createdAt: 1 });

      return res.json(messages);
    } catch (err) {
      console.error('Error in GET /api/admin/tasks/:id/messages', err);
      return res.status(500).json({
        message: 'Error loading task messages',
        error: err.message,
      });
    }
  }
);

router.post(
  '/tasks/:id/messages',
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

      if (!taskId) {
        return res.status(400).json({ message: 'Task ID is required' });
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

      const payload = {
        task: taskId,
        sender: req.user.id,
        text,
        fileUrl: fileUrl || undefined,
        fileName: fileName || undefined,
      };

      if (studentId) {
        payload.student = studentId;
        payload.peerStudentId = studentId;
      }

      const message = await Message.create(payload);

      const populated = await Message.findById(message._id).populate(
        'sender',
        'name email role'
      );

      return res.status(201).json(populated);
    } catch (err) {
      console.error('Error in POST /api/admin/tasks/:id/messages', err);
      return res.status(500).json({
        message: 'Error sending message',
        error: err.message,
      });
    }
  }
);

/**
 * NEW: Admin → Client chat endpoint
 * POST /api/admin/tasks/:id/chat/client
 */
router.post(
  '/tasks/:id/chat/client',
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

      if (!taskId) {
        return res.status(400).json({ message: 'Task ID is required' });
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

      const text = clean(value.text);
      const fileUrl = clean(value.fileUrl);
      const fileName = clean(value.fileName);
      const studentId = normalizeId(value.studentId);

      if (!text && !fileUrl) {
        return res.status(400).json({
          message: 'Message text or file is required',
        });
      }

      const payload = {
        task: taskId,
        sender: req.user.id,
        text,
        fileUrl: fileUrl || undefined,
        fileName: fileName || undefined,
        client: task.client, // explicitly mark client target
      };

      if (studentId) {
        payload.student = studentId;
        payload.peerStudentId = studentId;
      }

      const message = await Message.create(payload);

      const populated = await Message.findById(message._id).populate(
        'sender',
        'name email role'
      );

      return res.status(201).json(populated);
    } catch (err) {
      console.error('Error in POST /api/admin/tasks/:id/chat/client', err);
      return res.status(500).json({
        message: 'Error sending client chat message',
        error: err.message,
      });
    }
  }
);

/**
 * OPTIONAL: Admin → Student chat endpoint
 * POST /api/admin/tasks/:id/chat/student
 */
router.post(
  '/tasks/:id/chat/student',
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

      if (!taskId) {
        return res.status(400).json({ message: 'Task ID is required' });
      }

      const task = await Task.findById(taskId).populate(
        'client student',
        '_id name email role'
      );

      if (!task) {
        return res.status(404).json({ message: 'Task not found' });
      }

      const studentId = normalizeId(value.studentId) || (task.student && task.student.toString());

      if (!studentId) {
        return res.status(400).json({ message: 'Student ID is required for student chat' });
      }

      const text = clean(value.text);
      const fileUrl = clean(value.fileUrl);
      const fileName = clean(value.fileName);

      if (!text && !fileUrl) {
        return res.status(400).json({
          message: 'Message text or file is required',
        });
      }

      const payload = {
        task: taskId,
        sender: req.user.id,
        text,
        fileUrl: fileUrl || undefined,
        fileName: fileName || undefined,
        student: studentId,
        peerStudentId: studentId,
      };

      const message = await Message.create(payload);

      const populated = await Message.findById(message._id).populate(
        'sender',
        'name email role'
      );

      return res.status(201).json(populated);
    } catch (err) {
      console.error('Error in POST /api/admin/tasks/:id/chat/student', err);
      return res.status(500).json({
        message: 'Error sending student chat message',
        error: err.message,
      });
    }
  }
);

/**
 * ADMIN STUDENT DASHBOARD
 */
router.get(
  '/students/:id/dashboard',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const studentId = req.params.id;

      const student = await User.findById(studentId).select('-password');
      if (!student || student.role !== 'student') {
        return res.status(404).json({ message: 'Student not found' });
      }

      const [totalTasks, completedTasks, totalPayments] = await Promise.all([
        Task.countDocuments({ student: studentId }),
        Task.countDocuments({ student: studentId, status: 'completed' }),
        Payment.countDocuments({
          student: studentId,
          status: 'completed',
        }),
      ]);

      return res.json({
        student,
        totalTasks,
        completedTasks,
        totalPayments,
      });
    } catch (err) {
      console.error('Error in /api/admin/students/:id/dashboard', err);
      return res.status(500).json({
        message: 'Error loading student dashboard',
        error: err.message,
      });
    }
  }
);

/**
 * ADMIN STATS & PAYMENTS
 */
router.get(
  '/stats/overview',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const [
        totalUsers,
        totalStudents,
        totalClients,
        totalAdmins,
        totalTasks,
        paymentsAgg,
        completedAgg,
        clientProposedAgg,
      ] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ role: 'student' }),
        User.countDocuments({ role: 'client' }),
        User.countDocuments({ role: 'admin' }),
        Task.countDocuments(),
        Payment.aggregate([
          {
            $group: {
              _id: null,
              totalAmount: { $sum: '$netToStudent' },
            },
          },
        ]),
        Payment.aggregate([
          {
            $match: { status: 'completed' },
          },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: '$netToStudent' },
            },
          },
        ]),
        Task.aggregate([
          {
            $group: {
              _id: null,
              totalAmount: { $sum: '$budget' },
            },
          },
        ]),
      ]);

      const totalPayments =
        paymentsAgg.length > 0 ? paymentsAgg[0].totalAmount : 0;
      const completedPayments =
        completedAgg.length > 0 ? completedAgg[0].totalAmount : 0;
      const totalClientProposed =
        clientProposedAgg.length > 0 ? clientProposedAgg[0].totalAmount : 0;

      return res.json({
        totalUsers,
        totalStudents,
        totalClients,
        totalAdmins,
        totalTasks,
        totalPayments,
        completedPayments,
        totalClientProposed,
      });
    } catch (err) {
      console.error('Error in /api/admin/stats/overview', err);
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

router.get(
  '/stats/payments',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const completedAgg = await Payment.aggregate([
        { $match: { status: 'completed' } },
        {
          $group: {
            _id: null,
            totalCompletedAmount: { $sum: '$netToStudent' },
          },
        },
      ]);

      const heldAgg = await Payment.aggregate([
        { $match: { status: 'held' } },
        {
          $group: {
            _id: null,
            totalHeldAmount: { $sum: '$netToStudent' },
          },
        },
      ]);

      const totalCompletedAmount =
        completedAgg.length > 0 ? completedAgg[0].totalCompletedAmount : 0;
      const totalHeldAmount =
        heldAgg.length > 0 ? heldAgg[0].totalHeldAmount : 0;

      return res.json({
        totalCompletedAmount,
        totalHeldAmount,
      });
    } catch (err) {
      console.error('Error in /api/admin/stats/payments', err);
      return res.status(500).json({
        message: 'Error computing payment stats',
        error: err.message,
      });
    }
  }
);

router.get('/getTaskStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const total = await Task.countDocuments();
    const completed = await Task.countDocuments({
      status: 'completed',
    });
    const pending = total - completed;

    return res.json({
      total,
      completed,
      pending,
    });
  } catch (err) {
    return res.status(500).json({
      message: err.message,
    });
  }
});

router.get('/getDomainStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const stats = await Task.aggregate([
      {
        $group: {
          _id: '$domain',
          total: { $sum: 1 },
          completed: {
            $sum: {
              $cond: [{ $eq: ['$status', 'completed'] }, 1, 0],
            },
          },
        },
      },
    ]);

    const mapped = stats.map((s) => ({
      domain: !s._id || s._id === 'general' ? 'Other' : s._id,
      total: s.total,
      completed: s.completed,
    }));

    return res.json(mapped);
  } catch (err) {
    return res.status(500).json({
      message: err.message,
    });
  }
});

router.get('/getTopStudents', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const stats = await Payment.aggregate([
      { $match: { status: 'completed' } },
      {
        $group: {
          _id: '$student',
          total: { $sum: '$netToStudent' },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'studentDoc',
        },
      },
      { $unwind: '$studentDoc' },
      {
        $project: {
          _id: 0,
          studentId: '$_id',
          name: '$studentDoc.name',
          email: '$studentDoc.email',
          total: 1,
        },
      },
    ]);

    return res.json(stats);
  } catch (err) {
    console.error('Error in /api/admin/getTopStudents', err);
    return res.status(500).json({ message: err.message });
  }
});

router.get(
  '/getTimeSeriesStats',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const stats = await Task.aggregate([
        {
          $group: {
            _id: {
              month: { $month: '$createdAt' },
              year: { $year: '$createdAt' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]);

      return res.json(stats);
    } catch (err) {
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

router.get(
  '/getTaskFunnelStats',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const stats = {
        total: await Task.countDocuments(),
        assigned: await Task.countDocuments({
          student: { $ne: null },
        }),
        completed: await Task.countDocuments({
          status: 'completed',
        }),
      };

      return res.json(stats);
    } catch (err) {
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

/**
 * ADMIN PAYMENTS
 */
router.get('/payments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const status = clean(req.query.status);
    const filter = {};
    if (status) filter.status = status;

    const payments = await Payment.find(filter)
      .populate('student', 'name email')
      .populate('client', 'name email')
      .populate('task', 'title budget status');

    return res.json(payments);
  } catch (err) {
    console.error('Error in GET /api/admin/payments', err);
    return res.status(500).json({ message: err.message });
  }
});

router.patch(
  '/payments/:id/status',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { error, value } = paymentStatusSchema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      if (error) {
        return res.status(400).json({
          message: 'Validation error',
          details: error.details.map((d) => d.message),
        });
      }

      const { id } = req.params;

      const payment = await Payment.findById(id);
      if (!payment) {
        return res.status(404).json({ message: 'Payment not found' });
      }

      payment.status = value.status;
      if (typeof value.adminNote === 'string' && value.adminNote.trim()) {
        payment.declineReason = value.adminNote.trim();
      }

      await payment.save();

      return res.json({
        message: 'Payment status updated',
        payment,
      });
    } catch (err) {
      console.error('Error in PATCH /api/admin/payments/:id/status', err);
      return res.status(500).json({ message: err.message });
    }
  }
);

router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const payments = await Payment.find({
      status: 'held',
    })
      .populate(
        'student',
        'name email bankAccountHolderName bankName bankAccountNumber ifscCode'
      )
      .populate('task', 'title budget status');

    return res.json(payments);
  } catch (err) {
    return res.status(500).json({
      message: err.message,
    });
  }
});

router.post(
  '/releasePayment/:id',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      const payment = await Payment.findById(id);
      if (!payment) {
        return res.status(404).json({
          message: 'Not found',
        });
      }

      if (payment.status !== 'held') {
        return res.status(400).json({
          message: 'Payment is not approved by client yet',
        });
      }

      payment.status = 'completed';
      await payment.save();

      const student = await User.findById(payment.student);
      if (student) {
        const amt = payment.netToStudent || payment.amount || 0;

        student.wallet = (student.wallet || 0) + amt;
        student.pendingEarnings = Math.max(
          0,
          (student.pendingEarnings || 0) - amt
        );
        student.totalEarningsReleased =
          (student.totalEarningsReleased || 0) + amt;

        await student.save();
      }

      return res.json({
        message: 'Payment released',
      });
    } catch (err) {
      console.error('Error in /api/admin/releasePayment/:id', err);
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

router.get(
  '/stats/growth',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const {
        metric = 'tasks',
        granularity = 'month',
        from,
        to,
      } = req.query;

      const startDate = from ? new Date(from) : new Date('2024-01-01');
      const endDate = to ? new Date(to) : new Date();

      let model;
      const match = {
        createdAt: { $gte: startDate, $lte: endDate },
      };

      switch (metric) {
        case 'users':
          model = User;
          break;
        case 'students':
          model = User;
          match.role = 'student';
          break;
        case 'clients':
          model = User;
          match.role = 'client';
          break;
        case 'tasks':
          model = Task;
          break;
        case 'completedPayments':
          model = Payment;
          match.status = 'completed';
          break;
        default:
          return res.status(400).json({ message: 'Invalid metric' });
      }

      const dateTrunc =
        granularity === 'day'
          ? { $dateTrunc: { date: '$createdAt', unit: 'day' } }
          : { $dateTrunc: { date: '$createdAt', unit: 'month' } };

      const pipeline = [
        { $match: match },
        {
          $group: {
            _id: dateTrunc,
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ];

      const stats = await model.aggregate(pipeline);

      const mapped = stats.map((s) => ({
        bucket: s._id,
        count: s.count,
      }));

      return res.json(mapped);
    } catch (err) {
      console.error('Error in /api/admin/stats/growth', err);
      return res.status(500).json({
        message: 'Error loading growth stats',
        error: err.message,
      });
    }
  }
);

module.exports = router;