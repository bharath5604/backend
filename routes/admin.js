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
URL: /api/admin/users
Query: ?role&company&location&domain
=====================================
*/

router.get('/users', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { role, company, location, domain } = req.query;
    const filter = {};

    // by default exclude admins unless explicitly requested
    if (role) {
      filter.role = role;
    } else {
      filter.role = { $ne: 'admin' };
    }

    if (company) filter.company = company;
    if (location) filter.location = location;
    if (domain) filter.domain = domain;

    const users = await User.find(filter).select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching users',
      error: err.message,
    });
  }
});

/*
=====================================
OVERVIEW STATS
/api/admin/stats/overview
=====================================
*/

router.get('/stats/overview', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalStudents = await User.countDocuments({ role: 'student' });
    const totalTasks = await Task.countDocuments();
    const totalPayments = await Payment.countDocuments();

    res.json({
      totalUsers,
      totalStudents,
      totalTasks,
      totalPayments,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching overview stats',
      error: err.message,
    });
  }
});

/*
=====================================
TASK STATS
/api/admin/getTaskStats
=====================================
*/

router.get('/getTaskStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const total = await Task.countDocuments();
    const completed = await Task.countDocuments({ status: 'completed' });
    const pending = await Task.countDocuments({ status: 'pending' });

    res.json({
      total,
      completed,
      pending,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching task stats',
      error: err.message,
    });
  }
});

/*
=====================================
DOMAIN STATS
/api/admin/getDomainStats
=====================================
*/

router.get('/getDomainStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const stats = await Task.aggregate([
      {
        $group: {
          _id: '$domain',
          count: { $sum: 1 },
        },
      },
    ]);

    res.json(stats);
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching domain stats',
      error: err.message,
    });
  }
});

/*
=====================================
TOP STUDENTS
/api/admin/getTopStudents
=====================================
*/

router.get('/getTopStudents', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const stats = await Payment.aggregate([
      {
        $group: {
          _id: '$student',
          total: { $sum: '$amount' },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 5 },
    ]);

    res.json(stats);
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching top students',
      error: err.message,
    });
  }
});

/*
=====================================
TIME SERIES
/api/admin/getTimeSeriesStats
=====================================
*/

router.get('/getTimeSeriesStats', verifyJWT, ensureAdmin, async (req, res) => {
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

    res.json(stats);
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching time series stats',
      error: err.message,
    });
  }
});

/*
=====================================
TASK FUNNEL
/api/admin/getTaskFunnelStats
=====================================
*/

router.get('/getTaskFunnelStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const total = await Task.countDocuments();
    const assigned = await Task.countDocuments({ student: { $ne: null } });
    const completed = await Task.countDocuments({ status: 'completed' });

    res.json({
      total,
      assigned,
      completed,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching task funnel stats',
      error: err.message,
    });
  }
});

/*
=====================================
PENDING PAYMENTS
/api/admin/getPendingPayments
=====================================
*/

router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const payments = await Payment.find({ status: 'held' })
      .populate('student', 'name email')
      .populate('task', 'title budget');

    res.json(payments);
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching pending payments',
      error: err.message,
    });
  }
});

/*
=====================================
RELEASE PAYMENT
/api/admin/releasePayment/:id
=====================================
*/

router.post(
  '/releasePayment/:id',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.id);

      if (!payment) {
        return res.status(404).json({ message: 'Not found' });
      }

      payment.status = 'released';
      await payment.save();

      const student = await User.findById(payment.student);
      if (student) {
        student.wallet = (student.wallet || 0) + (payment.amount || 0);
        await student.save();
      }

      res.json({ message: 'Payment released' });
    } catch (err) {
      res.status(500).json({
        message: 'Error releasing payment',
        error: err.message,
      });
    }
  }
);

module.exports = router;
