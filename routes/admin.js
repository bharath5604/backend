// routes/admin.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const Bid = require('../models/Bid'); // ensure this model exists
const verifyJWT = require('../middleware/authMiddleware');

const ensureAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin only' });
  }
  next();
};

// GET /api/admin/users?role&company&location&domain
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

// Task analytics for charts
// GET /api/admin/stats/tasks
router.get('/stats/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  try {
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
    ]);

    const approvalTimes = await Task.aggregate([
      {
        $match: {
          'submission.approved': true,
          createdAt: { $exists: true },
          updatedAt: { $exists: true },
        },
      },
      {
        $project: {
          diffMs: { $subtract: ['$updatedAt', '$createdAt'] },
        },
      },
      {
        $group: {
          _id: null,
          avgMs: { $avg: '$diffMs' },
        },
      },
    ]);

    const avgMs = approvalTimes.length ? approvalTimes[0].avgMs : 0;

    res.json({
      perDomain,
      averageApprovalTimeMs: avgMs,
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error computing task stats', error: err.message });
  }
});

// Top students for leaderboard chart
// GET /api/admin/stats/top-students?limit=10
router.get(
  '/stats/top-students',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 10;

      const students = await User.find({ role: 'student' })
        .select(
          'name email totalScore totalScoreCount feedbackScores wallet'
        )
        .sort({ totalScore: -1 })
        .limit(limit);

      res.json(students);
    } catch (err) {
      res.status(500).json({
        message: 'Error fetching top students',
        error: err.message,
      });
    }
  }
);

// Optional: overall overview stats (for cards on dashboard)
// GET /api/admin/stats/overview
router.get('/stats/overview', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [userCounts, taskCounts, bidCount] = await Promise.all([
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
    ]);

    const result = {
      usersByRole: userCounts,
      tasksByStatus: taskCounts,
      totalUsers: userCounts.reduce((s, u) => s + u.count, 0),
      totalStudents:
        userCounts.find((u) => u._id === 'student')?.count || 0,
      totalClients:
        userCounts.find((u) => u._id === 'client')?.count || 0,
      totalAdmins:
        userCounts.find((u) => u._id === 'admin')?.count || 0,
      totalTasks: taskCounts.reduce((s, t) => s + t.count, 0),
      totalBids: bidCount,
    };

    res.json(result);
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error fetching overview stats', error: err.message });
  }
});

module.exports = router;
