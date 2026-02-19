const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const Bid = require('../models/Bid');
const verifyJWT = require('../middleware/authMiddleware');

const ensureAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin only' });
  }
  next();
};

// GET /api/admin/users?role&company&location&domain
// Default: show only non-admins; admins only if role=admin is passed.
router.get('/users', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { role, company, location, domain } = req.query;
    const filter = {};

    if (role) {
      // If role explicitly provided, use it (can be 'admin' if needed)
      filter.role = role;
    } else {
      // By default, hide admin accounts from Manage Users list
      filter.role = { $ne: 'admin' };
    }

    if (company) filter.company = company;
    if (location) filter.location = location;
    if (domain) filter.domain = domain;

    const users = await User.find(filter).select('-password');
    res.json(users);
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error fetching users', error: err.message });
  }
});

// PATCH /api/admin/users/:id/approve
router.patch('/users/:id/approve', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { isApproved } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isApproved },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ message: 'User updated', user });
  } catch (err) {
    res
      .status(400)
      .json({ message: 'Error updating user', error: err.message });
  }
});

// GET /api/admin/tasks?location&domain&company
router.get('/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { location, domain, company } = req.query;
    const filter = {};
    if (location) filter.location = location;
    if (domain) filter.domain = domain;
    if (company) filter.company = company;

    const tasks = await Task.find(filter).populate(
      'client',
      'name email company'
    );
    res.json(tasks);
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error fetching tasks', error: err.message });
  }
});

// Student dashboard / profile for admin charts
// GET /api/admin/students/:id/dashboard
router.get(
  '/students/:id/dashboard',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const student = await User.findById(req.params.id).select('-password');
      if (!student || student.role !== 'student') {
        return res.status(404).json({ message: 'Student not found' });
      }

      const domains = (student.feedbackScores || []).map((d) => ({
        domain: d.domain,
        averageScore: d.count > 0 ? d.totalScore / d.count : 0,
        count: d.count,
      }));

      const totalAverage =
        student.totalScoreCount > 0
          ? student.totalScore / student.totalScoreCount
          : 0;

      const recentTasks = await Task.find({
        'submission.student': student._id,
      })
        .sort({ updatedAt: -1 })
        .limit(10)
        .select(
          'title domain company rating score feedback status updatedAt'
        );

      res.json({
        student: {
          id: student._id,
          name: student.name,
          email: student.email,
          totalScore: student.totalScore,
          totalScoreCount: student.totalScoreCount,
          totalAverageScore: totalAverage,
          domains,
          wallet: student.wallet || 0,
        },
        recentTasks,
      });
    } catch (err) {
      res.status(500).json({
        message: 'Error fetching student dashboard',
        error: err.message,
      });
    }
  }
);

// Admin payments list
// GET /api/admin/payments?status=held|released|declined|contested
router.get('/payments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const payments = await Payment.find(filter)
      .populate('task', 'title status')
      .populate('client', 'name email company')
      .populate('student', 'name email');

    res.json(payments);
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error fetching payments', error: err.message });
  }
});

// Admin override/resolve payment
// PATCH /api/admin/payments/:id/status  { status, adminNote }
router.patch(
  '/payments/:id/status',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { status, adminNote } = req.body;
      const allowed = ['held', 'released', 'declined', 'contested'];
      if (!allowed.includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }

      const payment = await Payment.findById(req.params.id);
      if (!payment) {
        return res.status(404).json({ message: 'Payment not found' });
      }

      payment.status = status;
      if (adminNote) payment.adminNote = adminNote;

      // if admin forces release, credit student wallet
      if (status === 'released') {
        const student = await User.findById(payment.student);
        if (student) {
          const credit = payment.netToStudent || payment.amount || 0;
          student.wallet = (student.wallet || 0) + credit;
          await student.save();
        }
      }

      await payment.save();

      res.json({ message: 'Payment updated', payment });
    } catch (err) {
      res
        .status(500)
        .json({ message: 'Error updating payment', error: err.message });
    }
  }
);

// ======== HIGH-LEVEL ANALYTICS STATS ========

// Overall overview stats (for KPI cards on dashboard)
// GET /api/admin/stats/overview
router.get('/stats/overview', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [userCounts, taskCounts, bidCount, paymentAgg] = await Promise.all([
      User.aggregate([
        {
          $group: {
            _id: '$role',
            count: { $sum: 1 },
          },
        },
      ]),
      Task.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      Bid.countDocuments({}),
      Payment.aggregate([
        {
          $group: {
            _id: null,
            totalAmount: { $sum: '$amount' },
            totalNetToStudent: { $sum: '$netToStudent' },
          },
        },
      ]),
    ]);

    const totalStudents =
      userCounts.find((u) => u._id === 'student')?.count || 0;
    const totalClients =
      userCounts.find((u) => u._id === 'client')?.count || 0;
    const totalAdmins =
      userCounts.find((u) => u._id === 'admin')?.count || 0;

    const paymentsSummary = paymentAgg[0] || {
      totalAmount: 0,
      totalNetToStudent: 0,
    };

    const result = {
      usersByRole: userCounts,
      tasksByStatus: taskCounts,
      totalUsers: userCounts.reduce((s, u) => s + u.count, 0),
      totalStudents,
      totalClients,
      totalAdmins,
      totalNonAdminUsers: totalStudents + totalClients,
      totalTasks: taskCounts.reduce((s, t) => s + t.count, 0),
      totalBids: bidCount,
      totalPaymentsAmount: paymentsSummary.totalAmount || 0,
      totalPaymentsNetToStudent: paymentsSummary.totalNetToStudent || 0,
    };

    res.json(result);
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching overview stats',
      error: err.message,
    });
  }
});

// Task analytics stats
// GET /api/admin/stats/tasks
router.get('/stats/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    // Per-domain counts and completed counts
    const perDomain = await Task.aggregate([
      {
        $group: {
          _id: '$domain',
          count: { $sum: 1 },
          completed: {
            $sum: {
              $cond: [{ $eq: ['$status', 'completed'] }, 1, 0],
            },
          },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Average approval time (createdAt -> updatedAt) for in_progress/completed
    const approvalAgg = await Task.aggregate([
      {
        $match: {
          createdAt: { $exists: true },
          updatedAt: { $exists: true },
          status: { $in: ['in_progress', 'completed'] },
        },
      },
      {
        $project: {
          createdAt: 1,
          updatedAt: 1,
          approvalTimeMs: { $subtract: ['$updatedAt', '$createdAt'] },
        },
      },
      {
        $group: {
          _id: null,
          averageApprovalTimeMs: { $avg: '$approvalTimeMs' },
        },
      },
    ]);

    const averageApprovalTimeMs =
      (approvalAgg[0] && approvalAgg[0].averageApprovalTimeMs) || 0;

    res.json({
      averageApprovalTimeMs,
      perDomain,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error computing task stats',
      error: err.message,
    });
  }
});

// Time-series stats for users, tasks, payments
// GET /api/admin/stats/timeseries?range=30d|90d&bucket=day|week
router.get('/stats/timeseries', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const range = req.query.range === '90d' ? 90 : 30;
    const bucket = req.query.bucket === 'week' ? 'week' : 'day';

    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - range);

    const dateExpr =
      bucket === 'week'
        ? {
            $dateTrunc: {
              date: '$createdAt',
              unit: 'week',
            },
          }
        : {
            $dateTrunc: {
              date: '$createdAt',
              unit: 'day',
            },
          };

    const [users, tasks, payments] = await Promise.all([
      User.aggregate([
        { $match: { createdAt: { $gte: from } } },
        {
          $group: {
            _id: dateExpr,
            total: { $sum: 1 },
            students: {
              $sum: {
                $cond: [{ $eq: ['$role', 'student'] }, 1, 0],
              },
            },
            clients: {
              $sum: {
                $cond: [{ $eq: ['$role', 'client'] }, 1, 0],
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Task.aggregate([
        { $match: { createdAt: { $gte: from } } },
        {
          $group: {
            _id: dateExpr,
            created: { $sum: 1 },
            completed: {
              $sum: {
                $cond: [{ $eq: ['$status', 'completed'] }, 1, 0],
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Payment.aggregate([
        { $match: { createdAt: { $gte: from } } },
        {
          $group: {
            _id: dateExpr,
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' },
            totalNetToStudent: { $sum: '$netToStudent' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({
      rangeDays: range,
      bucket,
      users,
      tasks,
      payments,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error computing time-series stats',
      error: err.message,
    });
  }
});

// Task funnel & timing metrics
// GET /api/admin/stats/task-funnel
router.get('/stats/task-funnel', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [funnelCounts, timingAgg] = await Promise.all([
      Task.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      Task.aggregate([
        {
          $match: {
            createdAt: { $exists: true },
            updatedAt: { $exists: true },
            status: 'completed',
          },
        },
        {
          $project: {
            createdAt: 1,
            firstBidAt: '$firstBidAt',
            completedAt: '$updatedAt',
          },
        },
        {
          $group: {
            _id: null,
            avgToFirstBidMs: {
              $avg: {
                $cond: [
                  { $and: ['$firstBidAt', '$createdAt'] },
                  { $subtract: ['$firstBidAt', '$createdAt'] },
                  null,
                ],
              },
            },
            avgToCompletionMs: {
              $avg: {
                $subtract: ['$completedAt', '$createdAt'],
              },
            },
          },
        },
      ]),
    ]);

    const timing = timingAgg[0] || {
      avgToFirstBidMs: 0,
      avgToCompletionMs: 0,
    };

    res.json({
      funnelCounts,
      avgToFirstBidMs: timing.avgToFirstBidMs || 0,
      avgToCompletionMs: timing.avgToCompletionMs || 0,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error computing task funnel stats',
      error: err.message,
    });
  }
});

// Domain-level users/projects/bids/payments
// GET /api/admin/stats/by-domain
router.get('/stats/by-domain', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [usersByDomain, tasksByDomain, bidsByDomain, paymentsByDomain] =
      await Promise.all([
        User.aggregate([
          { $match: { domain: { $exists: true, $ne: '' } } },
          { $group: { _id: '$domain', count: { $sum: 1 } } },
        ]),
        Task.aggregate([
          { $match: { domain: { $exists: true, $ne: '' } } },
          {
            $group: {
              _id: '$domain',
              count: { $sum: 1 },
              completed: {
                $sum: {
                  $cond: [{ $eq: ['$status', 'completed'] }, 1, 0],
                },
              },
            },
          },
        ]),
        Bid.aggregate([
          { $match: { domain: { $exists: true, $ne: '' } } },
          { $group: { _id: '$domain', count: { $sum: 1 } } },
        ]),
        Payment.aggregate([
          { $match: { domain: { $exists: true, $ne: '' } } },
          {
            $group: {
              _id: '$domain',
              totalAmount: { $sum: '$amount' },
              totalNetToStudent: { $sum: '$netToStudent' },
            },
          },
        ]),
      ]);

    const domainsMap = {};

    usersByDomain.forEach((u) => {
      domainsMap[u._id] =
        domainsMap[u._id] || {
          domain: u._id,
          users: 0,
          projects: 0,
          completedProjects: 0,
          bids: 0,
          totalAmount: 0,
          totalNetToStudent: 0,
        };
      domainsMap[u._id].users = u.count;
    });

    tasksByDomain.forEach((t) => {
      domainsMap[t._id] =
        domainsMap[t._id] || {
          domain: t._id,
          users: 0,
          projects: 0,
          completedProjects: 0,
          bids: 0,
          totalAmount: 0,
          totalNetToStudent: 0,
        };
      domainsMap[t._id].projects = t.count;
      domainsMap[t._id].completedProjects = t.completed;
    });

    bidsByDomain.forEach((b) => {
      domainsMap[b._id] =
        domainsMap[b._id] || {
          domain: b._id,
          users: 0,
          projects: 0,
          completedProjects: 0,
          bids: 0,
          totalAmount: 0,
          totalNetToStudent: 0,
        };
      domainsMap[b._id].bids = b.count;
    });

    paymentsByDomain.forEach((p) => {
      domainsMap[p._id] =
        domainsMap[p._id] || {
          domain: p._id,
          users: 0,
          projects: 0,
          completedProjects: 0,
          bids: 0,
          totalAmount: 0,
          totalNetToStudent: 0,
        };
      domainsMap[p._id].totalAmount = p.totalAmount || 0;
      domainsMap[p._id].totalNetToStudent = p.totalNetToStudent || 0;
    });

    const result = Object.values(domainsMap);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      message: 'Error computing domain stats',
      error: err.message,
    });
  }
});

// Top students for leaderboard chart (by earnings + score)
// GET /api/admin/stats/top-students?limit=10
router.get('/stats/top-students', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;

    // Join payments to compute total earnings per student
    const topByEarnings = await Payment.aggregate([
      {
        $match: {
          status: 'released',
          student: { $exists: true, $ne: null },
        },
      },
      {
        $group: {
          _id: '$student',
          totalEarnings: { $sum: '$netToStudent' },
        },
      },
      { $sort: { totalEarnings: -1 } },
      { $limit: limit },
    ]);

    const studentIds = topByEarnings.map((p) => p._id);
    const students = await User.find({
      _id: { $in: studentIds },
      role: 'student',
    }).select('name email totalScore totalScoreCount wallet');

    const studentMap = new Map(
      students.map((s) => [s._id.toString(), s])
    );

    const result = topByEarnings
      .map((e) => {
        const s = studentMap.get(e._id.toString());
        if (!s) return null;
        const avgScore =
          s.totalScoreCount > 0
            ? s.totalScore / s.totalScoreCount
            : 0;
        return {
          id: s._id,
          name: s.name,
          email: s.email,
          totalEarnings: e.totalEarnings,
          averageScore: avgScore,
          wallet: s.wallet || 0,
        };
      })
      .filter(Boolean);

    res.json(result);
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching top students',
      error: err.message,
    });
  }
});

module.exports = router;
