const express = require('express');
const router = express.Router();
const Joi = require('joi');

const User = require('../models/User');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const Bid = require('../models/Bid');

const verifyJWT = require('../middleware/authMiddleware');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/*
=====================================
ADMIN CHECK
=====================================
*/
const ensureAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      message: 'Admin only',
    });
  }
  next();
};

/*
=====================================
JOI SCHEMAS
=====================================
*/
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

/*
=====================================
ADMIN USERS LIST
/api/admin/users
=====================================
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

/*
=====================================
ADMIN UPDATE USER APPROVAL
PATCH /api/admin/users/:id/approve
=====================================
*/
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

/*
=====================================
ADMIN TASKS LIST
/api/admin/tasks
=====================================
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

/*
=====================================
TASK FILTER VALUES
/api/admin/tasks/filters
=====================================
*/
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

/*
=====================================
TASK CANDIDATES FOR ADMIN
GET /api/admin/tasks/:id/candidates
=====================================
*/
router.get('/tasks/:id/candidates', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id).select(
      'requiredSkills status'
    );

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const match = {
      role: 'student',
      isApproved: true,
    };

    if (Array.isArray(task.requiredSkills) && task.requiredSkills.length > 0) {
      match.skills = { $in: task.requiredSkills };
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
});

/*
=====================================
ADMIN ASSIGN STUDENT TO TASK
POST /api/admin/tasks/:id/assign
=====================================
*/
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

    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.status !== 'open') {
      return res.status(400).json({
        message: 'Only open tasks can be assigned',
      });
    }

    const student = await User.findById(value.studentId).select(
      'name email role isApproved skills'
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
    task.attemptCount = 0;

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

/*
=====================================
STUDENT DASHBOARD (DETAIL)
/api/admin/students/:id/dashboard
=====================================
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

      const [totalTasks, completedTasks, totalBids, totalPayments] =
        await Promise.all([
          Task.countDocuments({ student: studentId }),
          Task.countDocuments({ student: studentId, status: 'completed' }),
          Bid.countDocuments({ student: studentId }),
          Payment.countDocuments({
            student: studentId,
            status: 'completed',
          }),
        ]);

      return res.json({
        student,
        totalTasks,
        completedTasks,
        totalBids,
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

/*
=====================================
OVERVIEW STATS
/api/admin/stats/overview
=====================================
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
        totalBids,
        paymentsAgg,
        completedAgg,
        clientProposedAgg,
      ] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ role: 'student' }),
        User.countDocuments({ role: 'client' }),
        User.countDocuments({ role: 'admin' }),
        Task.countDocuments(),
        Bid.countDocuments({}),
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
        totalBids,
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

/*
=====================================
PAYMENT QUOTE STATS
/api/admin/stats/payments
=====================================
*/
router.get(
  '/stats/payments',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const acceptedAgg = await Payment.aggregate([
        {
          $match: {
            status: { $in: ['held', 'completed'] },
          },
        },
        {
          $lookup: {
            from: 'bids',
            localField: 'bid',
            foreignField: '_id',
            as: 'bid',
          },
        },
        { $unwind: '$bid' },
        {
          $match: {
            'bid.status': 'accepted',
          },
        },
        {
          $group: {
            _id: null,
            totalAcceptedQuotes: { $sum: '$bid.quote' },
          },
        },
      ]);

      const totalAcceptedQuotes =
        acceptedAgg.length > 0 ? acceptedAgg[0].totalAcceptedQuotes : 0;

      const completedAgg = await Payment.aggregate([
        { $match: { status: 'completed' } },
        {
          $lookup: {
            from: 'bids',
            localField: 'bid',
            foreignField: '_id',
            as: 'bid',
          },
        },
        { $unwind: '$bid' },
        { $match: { 'bid.status': 'accepted' } },
        {
          $group: {
            _id: null,
            totalCompletedQuotes: { $sum: '$bid.quote' },
          },
        },
      ]);

      const totalCompletedQuotes =
        completedAgg.length > 0 ? completedAgg[0].totalCompletedQuotes : 0;

      const totalPendingQuotes = totalAcceptedQuotes - totalCompletedQuotes;

      return res.json({
        totalAcceptedQuotes,
        totalCompletedQuotes,
        totalPendingQuotes,
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

/*
=====================================
TASK STATS
=====================================
*/
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

/*
=====================================
DOMAIN STATS
=====================================
*/
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

/*
=====================================
TOP STUDENTS
=====================================
*/
router.get('/getTopStudents', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const stats = await Payment.aggregate([
      { $match: { status: 'completed' } },
      {
        $lookup: {
          from: 'bids',
          localField: 'bid',
          foreignField: '_id',
          as: 'bid',
        },
      },
      { $unwind: '$bid' },
      { $match: { 'bid.status': 'accepted' } },
      {
        $group: {
          _id: '$student',
          total: { $sum: '$bid.quote' },
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

/*
=====================================
TIME SERIES
=====================================
*/
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
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.month': 1 } },
      ]);

      return res.json(stats);
    } catch (err) {
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
TASK FUNNEL
=====================================
*/
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

/*
=====================================
ADMIN PAYMENTS LIST
GET /api/admin/payments?status=created|held|completed|cancelled
=====================================
*/
router.get('/payments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const status = clean(req.query.status);
    const filter = {};
    if (status) filter.status = status;

    const payments = await Payment.find(filter)
      .populate('student', 'name email')
      .populate('client', 'name email')
      .populate('task', 'title budget status')
      .populate('bid', 'quote amount');

    return res.json(payments);
  } catch (err) {
    console.error('Error in GET /api/admin/payments', err);
    return res.status(500).json({ message: err.message });
  }
});

/*
=====================================
ADMIN UPDATE PAYMENT STATUS (generic)
PATCH /api/admin/payments/:id/status
=====================================
*/
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

/*
=====================================
PENDING PAYMENTS
Show only payments approved by client (Payment.status = 'held')
=====================================
*/
router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const payments = await Payment.find({
      status: 'held',
    })
      .populate(
        'student',
        'name email bankAccountHolderName bankName bankAccountNumber ifscCode'
      )
      .populate('task', 'title budget status')
      .populate('bid', 'quote amount');

    return res.json(payments);
  } catch (err) {
    return res.status(500).json({
      message: err.message,
    });
  }
});

/*
=====================================
RELEASE PAYMENT
POST /api/admin/releasePayment/:id
=====================================
*/
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

/*
=====================================
GROWTH STATS
GET /api/admin/stats/growth
=====================================
*/
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
        case 'bids':
          model = Bid;
          break;
        case 'successfulBids':
          model = Bid;
          match.status = 'accepted';
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