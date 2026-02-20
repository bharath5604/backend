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
      const { id } = req.params;
      const { isApproved } = req.body;

      const user = await User.findByIdAndUpdate(
        id,
        { isApproved: !!isApproved },
        { new: true }
      ).select('-password');

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      res.json({
        message: 'Approval updated',
        user,
      });
    } catch (err) {
      console.error('Error in PATCH /api/admin/users/:id/approve', err);
      res.status(500).json({
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
TASK FILTER VALUES (NEW)
/api/admin/tasks/filters
Return distinct lists for dropdowns: company, location, domain
=====================================
*/

router.get(
  '/tasks/filters',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const [companies, locations, domains] = await Promise.all([
        Task.distinct('company'),
        Task.distinct('location'),
        Task.distinct('domain'),
      ]);

      res.json({
        companies: companies.filter(Boolean),
        locations: locations.filter(Boolean),
        domains: domains.filter(Boolean),
      });
    } catch (err) {
      console.error('Error in /api/admin/tasks/filters', err);
      res.status(500).json({
        message: 'Error loading task filters',
        error: err.message,
      });
    }
  }
);

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
            status: 'released',
          }),
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

Client payments card uses totalClientProposed (sum of Task.budget)
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
        // total payments (all netToStudent, regardless of status)
        Payment.aggregate([
          {
            $group: {
              _id: null,
              totalAmount: { $sum: '$netToStudent' },
            },
          },
        ]),
        // completed payments = released
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
        // sum of client proposed task budgets
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
        totalPayments,
        completedPayments,
        totalClientProposed,
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
PAYMENT QUOTE STATS
/api/admin/stats/payments
- totalAcceptedQuotes: sum of Bid.quote with status 'accepted'
- totalCompletedQuotes: sum of Bid.quote where Payment.status 'released'
- totalPendingQuotes: difference
=====================================
*/

router.get(
  '/stats/payments',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      // Sum of all accepted bid quotes
      const acceptedAgg = await Bid.aggregate([
        { $match: { status: 'accepted' } },
        {
          $group: {
            _id: null,
            totalAcceptedQuotes: { $sum: '$quote' },
          },
        },
      ]);

      const totalAcceptedQuotes =
        acceptedAgg.length > 0 ? acceptedAgg[0].totalAcceptedQuotes : 0;

      // Sum of quotes for payments that are released (completed)
      const completedAgg = await Payment.aggregate([
        { $match: { status: 'released' } },
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

      res.json({
        totalAcceptedQuotes,
        totalCompletedQuotes,
        totalPendingQuotes,
      });
    } catch (err) {
      console.error('Error in /api/admin/stats/payments', err);
      res.status(500).json({
        message: 'Error computing payment stats',
        error: err.message,
      });
    }
  }
);

/*
=====================================
TASK STATS
(getTaskStats card)
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

      // pending = everything not completed (open + assigned + under_review + declined)
      const pending = total - completed;

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
          $match: { status: 'released' }, // only count actually released payments
        },
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
ADMIN PAYMENTS LIST
GET /api/admin/payments?status=held|approved|released|cancelled|declined
=====================================
*/

router.get(
  '/payments',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { status } = req.query;
      const filter = {};
      if (status) filter.status = status;

      const payments = await Payment.find(filter)
        .populate('student', 'name email')
        .populate('client', 'name email')
        .populate('task', 'title budget status')
        .populate('bid', 'quote amount');

      res.json(payments);
    } catch (err) {
      console.error('Error in GET /api/admin/payments', err);
      res.status(500).json({ message: err.message });
    }
  }
);

/*
=====================================
ADMIN UPDATE PAYMENT STATUS (generic)
PATCH /api/admin/payments/:id/status
body: { status, adminNote? }
=====================================
*/

router.patch(
  '/payments/:id/status',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, adminNote } = req.body;

      const payment = await Payment.findById(id);
      if (!payment) {
        return res.status(404).json({ message: 'Payment not found' });
      }

      if (status) {
        payment.status = status;
      }
      if (adminNote) {
        payment.declineReason = adminNote;
      }

      await payment.save();

      res.json({
        message: 'Payment status updated',
        payment,
      });
    } catch (err) {
      console.error('Error in PATCH /api/admin/payments/:id/status', err);
      res.status(500).json({ message: err.message });
    }
  }
);

/*
=====================================
PENDING PAYMENTS
Show only payments approved by client (Payment.status = 'approved')
=====================================
*/

router.get(
  '/getPendingPayments',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const payments = await Payment.find({
        status: 'approved',
      })
        .populate(
          'student',
          'name email bankAccountHolderName bankName bankAccountNumber ifscCode'
        )
        .populate('task', 'title budget status')
        .populate('bid', 'quote amount');

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
Uses netToStudent for wallet and earnings stats
POST /api/admin/releasePayment/:id
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

      // Only allow releasing client-approved payments
      if (payment.status !== 'approved') {
        return res.status(400).json({
          message: 'Payment is not approved by client yet',
        });
      }

      payment.status = 'released';
      await payment.save();

      const student = await User.findById(payment.student);
      if (student) {
        const amt = payment.netToStudent || payment.amount || 0;

        // wallet balance
        student.wallet = (student.wallet || 0) + amt;

        // earnings stats for profile overview
        student.pendingEarnings = Math.max(
          0,
          (student.pendingEarnings || 0) - amt
        );
        student.totalEarningsReleased =
          (student.totalEarningsReleased || 0) + amt;

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
          match.status = 'accepted';
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
