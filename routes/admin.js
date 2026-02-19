const express = require('express');
const router = express.Router();

const User = require('../models/User');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const Bid = require('../models/Bid');

const verifyJWT = require('../middleware/authMiddleware');

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
ADMIN USERS LIST
/api/admin/users
Used by AdminUsersScreen via AdminService.getUsers
=====================================
*/

router.get('/users', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { role, company, location, domain } = req.query;

    const filter = {};
    if (role) filter.role = role;
    if (company) filter.company = company;
    if (location) filter.location = location;
    if (domain) filter.domain = domain;

    const users = await User.find(filter).select('-password');

    res.json(users);
  } catch (err) {
    console.error('Error in /api/admin/users', err);
    res.status(500).json({
      message: 'Error loading users',
      error: err.message,
    });
  }
});

/*
=====================================
ADMIN TASKS LIST
/api/admin/tasks
Used by AdminTasksScreen via AdminService.getTasks
=====================================
*/

router.get('/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { company, location, domain } = req.query;

    const filter = {};
    if (company) filter.company = company;
    if (location) filter.location = location;
    if (domain) filter.domain = domain;

    const tasks = await Task.find(filter)
      .populate('client', 'name email')
      .populate('student', 'name email');

    res.json(tasks);
  } catch (err) {
    console.error('Error in /api/admin/tasks', err);
    res.status(500).json({
      message: 'Error loading tasks',
      error: err.message,
    });
  }
});

/*
=====================================
STUDENT DASHBOARD (DETAIL)
/api/admin/students/:id/dashboard
Used by AdminStudentDashboardService
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
          // count of payments where student got paid (released)
          Payment.countDocuments({ student: studentId, status: 'released' }),
        ]);

      res.json({
        student,
        totalTasks,
        completedTasks,
        totalBids,
        totalPayments,
      });
    } catch (err) {
      console.error('Error in /api/admin/students/:id/dashboard', err);
      res.status(500).json({
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
Uses netToStudent for totals and adds client proposal sum
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
        releasedAgg,
        clientProposedAgg,
      ] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ role: 'student' }),
        User.countDocuments({ role: 'client' }),
        User.countDocuments({ role: 'admin' }),
        Task.countDocuments(),
        Bid.countDocuments({}),
        // Total sum of student-side amounts (all accepted bids)
        Payment.aggregate([
          {
            $group: {
              _id: null,
              totalAmount: { $sum: '$netToStudent' },
            },
          },
        ]),
        // Sum of bid amounts actually paid out to students
        Payment.aggregate([
          {
            $match: { status: 'released' },
          },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: '$netToStudent' },
            },
          },
        ]),
        // Total sum of client proposed budgets (all tasks)
        Task.aggregate([
          {
            $group: {
              _id: null,
              totalAmount: { $sum: '$budget' }, // or '$amount' if your Task uses that field
            },
          },
        ]),
      ]);

      const totalPayments =
        paymentsAgg.length > 0 ? paymentsAgg[0].totalAmount : 0;
      const completedPayments =
        releasedAgg.length > 0 ? releasedAgg[0].totalAmount : 0;
      const totalClientProposed =
        clientProposedAgg.length > 0 ? clientProposedAgg[0].totalAmount : 0;

      res.json({
        totalUsers,
        totalStudents,
        totalClients,
        totalAdmins,
        totalTasks,
        totalBids,
        totalPayments,       // sum of all accepted bids (netToStudent)
        completedPayments,   // sum of released bids (netToStudent)
        totalClientProposed, // sum of client proposed budgets
      });
    } catch (err) {
      console.error('Error in /api/admin/stats/overview', err);
      res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
TASK STATS
=====================================
*/

router.get(
  '/getTaskStats',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const total = await Task.countDocuments();

      const completed = await Task.countDocuments({
        status: 'completed',
      });

      const pending = await Task.countDocuments({
        status: 'pending',
      });

      res.json({
        total,
        completed,
        pending,
      });
    } catch (err) {
      res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
DOMAIN STATS
=====================================
*/

router.get(
  '/getDomainStats',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const stats = await Task.aggregate([
        {
          $group: {
            _id: '$domain',
            total: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
            },
          },
        },
      ]);

      const mapped = stats.map((s) => ({
        domain: !s._id || s._id === 'general' ? 'Other' : s._id,
        total: s.total,
        completed: s.completed,
      }));

      res.json(mapped);
    } catch (err) {
      res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
TOP STUDENTS
Based on netToStudent (student earnings)
=====================================
*/

router.get(
  '/getTopStudents',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const stats = await Payment.aggregate([
        {
          $group: {
            _id: '$student',
            total: { $sum: '$netToStudent' }, // sum of student-side amounts
          },
        },
        { $sort: { total: -1 } },
        { $limit: 5 },
      ]);

      res.json(stats);
    } catch (err) {
      res.status(500).json({
        message: err.message,
      });
    }
  }
);

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
      ]);

      res.json(stats);
    } catch (err) {
      res.status(500).json({
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

      res.json(stats);
    } catch (err) {
      res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
PENDING PAYMENTS
Show only held payments; UI should display netToStudent
=====================================
*/

router.get(
  '/getPendingPayments',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const payments = await Payment.find({
        status: 'held',
      })
        .populate('student', 'name email')
        .populate('task', 'title budget')
        .populate('bid', 'amount');

      res.json(payments);
    } catch (err) {
      res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
RELEASE PAYMENT
Uses netToStudent when crediting wallet
=====================================
*/

router.post(
  '/releasePayment/:id',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      console.log('POST /api/admin/releasePayment', req.params.id);

      const payment = await Payment.findById(req.params.id);

      if (!payment) {
        return res.status(404).json({
          message: 'Not found',
        });
      }

      // Mark as released
      payment.status = 'released';
      await payment.save();

      // Credit the student's wallet with the student-side amount
      const student = await User.findById(payment.student);
      if (student) {
        student.wallet += payment.netToStudent;
        await student.save();
      }

      res.json({
        message: 'Payment released',
      });
    } catch (err) {
      console.error('Error in /api/admin/releasePayment/:id', err);
      res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
GROWTH STATS (TIME-SERIES)
GET /api/admin/stats/growth
Query:
  metric: users | students | clients | tasks | bids | successfulBids | completedPayments
  granularity: day | month
  from: ISO date string
  to: ISO date string
Returns: [{ bucket: '2026-02-01', count: 10 }, ...]
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
      let match = {
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
          match.status = 'accepted'; // adjust if you use a different field
          break;
        case 'completedPayments':
          model = Payment;
          match.status = 'released';
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

      res.json(mapped);
    } catch (err) {
      console.error('Error in /api/admin/stats/growth', err);
      res.status(500).json({
        message: 'Error loading growth stats',
        error: err.message,
      });
    }
  }
);

module.exports = router;
