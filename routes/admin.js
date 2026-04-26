// backend/routes/admin.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Joi = require('joi');

const User = require('../models/User');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const Message = require('../models/Message');
const Withdrawal = require('../models/Withdrawal'); // NEW: Link the withdrawal model

const verifyJWT = require('../middleware/authMiddleware');
const { sendNotification } = require('../utils/fcm');

// =========================================================
// HELPERS (RESTORED 100% FROM ORIGINAL)
// =========================================================

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

// =========================================================
// JOI SCHEMAS (RESTORED 100% FROM ORIGINAL)
// =========================================================

const approveUserSchema = Joi.object({
  isApproved: Joi.boolean().required(),
});

const adminTaskFilterSchema = Joi.object({
  company: Joi.string().allow('', null),
  location: Joi.string().allow('', null),
  domain: Joi.string().allow('', null),
  status: Joi.string()
    .valid('open', 'assigned', 'under_review', 'completed', 'declined', 'awaiting_advance', 'awaiting_final_payment')
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

const withdrawalStatusSchema = Joi.object({
  status: Joi.string().valid('processed', 'rejected').required(),
  adminNote: Joi.string().max(500).allow('', null),
});

// =========================================================
// USERS (RESTORED 100% FROM ORIGINAL)
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
// TASKS & WORKFLOW (RESTORED 100% & MODIFIED FOR TICK)
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

    const tasks = await Task.find(filter)
      .populate('client', 'name email company')
      .populate('student', 'name email skills')
      .populate('requestedStudent', 'name email')
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

/**
 * MODIFIED: TASK ASSIGNMENT (THE "TICK" LOGIC)
 * Now sets a REQUEST instead of immediate assignment.
 */
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

      const task = await Task.findById(taskId);
      if (!task) return res.status(404).json({ message: 'Task not found' });

      if (task.status !== 'open') {
        return res.status(400).json({ message: 'Only open tasks can receive requests' });
      }

      const student = await User.findById(studentId);
      if (!student || student.role !== 'student' || !student.isApproved) {
        return res.status(400).json({ message: 'Invalid or unapproved student' });
      }

      // INTEGRATE NEW WORKFLOW FIELDS
      task.requestedStudent = student._id;
      task.assignmentRequestStatus = 'request_sent';
      task.requestSentAt = new Date();
      task.assignedByAdmin = req.user.id;

      await task.save();

      // Notify Student
      await sendNotification(student._id, {
        title: 'New Work Invitation',
        body: `Admin invited you to work on: "${task.title}"`,
        data: {
          type: 'task_request',
          taskId: task._id.toString(),
        },
      });

      const populatedTask = await Task.findById(task._id)
        .populate('client', 'name email company')
        .populate('requestedStudent', 'name email skills')
        .populate('assignedByAdmin', 'name email');

      return res.json({
        message: 'Assignment request sent successfully',
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
// NEW: WITHDRAWAL MANAGEMENT
// =========================================================

/**
 * GET /api/admin/withdrawals
 * View all student payout requests
 */
router.get('/withdrawals', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const filter = status ? { status } : {};
    const requests = await Withdrawal.find(filter).populate('student', 'name email wallet').sort({ createdAt: -1 });
    return res.json(requests);
  } catch (err) {
    return res.status(500).json({ message: 'Error loading withdrawals', error: err.message });
  }
});

/**
 * PATCH /api/admin/withdrawals/:id
 * Logic: Mark as processed or reject (refund virtual balance)
 */
router.patch('/withdrawals/:id', verifyJWT, ensureAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { error, value } = withdrawalStatusSchema.validate(req.body);
    if (error) throw new Error(error.details[0].message);

    const withdrawal = await Withdrawal.findById(req.params.id).session(session);
    if (!withdrawal || withdrawal.status !== 'pending') throw new Error('Request not found or already processed');

    const student = await User.findById(withdrawal.student).session(session);

    if (value.status === 'rejected') {
      student.wallet += withdrawal.amount; // Refund balance to virtual wallet
      await student.save({ session });
    }

    withdrawal.status = value.status;
    withdrawal.adminNote = value.adminNote;
    withdrawal.processedAt = new Date();
    await withdrawal.save({ session });

    await session.commitTransaction();

    await sendNotification(student._id, {
      title: value.status === 'processed' ? 'Withdrawal Completed' : 'Withdrawal Rejected',
      body: value.status === 'processed' ? `₹${withdrawal.amount} has been sent to your bank.` : `Request for ₹${withdrawal.amount} was rejected. Funds refunded to wallet.`,
      data: { type: 'withdrawal_update' }
    });

    return res.json({ message: `Request marked as ${value.status}`, withdrawal });
  } catch (err) {
    await session.abortTransaction();
    return res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

// =========================================================
// ADMIN MESSAGES (RESTORED 100% FROM ORIGINAL)
// =========================================================

router.get('/tasks/:id/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const taskId = normalizeId(req.params.id);
    const studentId = normalizeId(req.query.studentId);

    const filter = { task: taskId };
    if (studentId) filter.student = studentId;

    const messages = await Message.find(filter)
      .populate('sender', 'name email role')
      .populate('receiver', 'name email role')
      .sort({ createdAt: 1 });

    return res.json(messages);
  } catch (err) {
    return res.status(500).json({ message: 'Error loading task messages' });
  }
});

router.get(
  '/tasks/:id/chat/client/messages',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const taskId = normalizeId(req.params.id);
      const task = await Task.findById(taskId);
      const clientId = toObjectIdString(task.client);
      const adminId = toObjectIdString(req.user.id);

      const messages = await Message.find({
        task: taskId,
        $or: [
          { sender: adminId, receiver: clientId },
          { sender: clientId, receiver: adminId },
        ],
      })
        .populate('sender receiver', 'name email role')
        .sort({ createdAt: 1 });

      return res.json(messages);
    } catch (err) {
      return res.status(500).json({ message: 'Error loading client chat messages' });
    }
  }
);

router.post(
  '/tasks/:id/chat/client/messages',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { error, value } = adminMessageSchema.validate(req.body);
      const task = await Task.findById(req.params.id);
      const clientId = toObjectIdString(task.client);

      const message = await Message.create({
        task: req.params.id,
        sender: req.user.id,
        receiver: clientId,
        student: value.studentId || task.student,
        text: clean(value.text),
        fileUrl: clean(value.fileUrl),
        fileName: clean(value.fileName),
      });

      const populated = await Message.findById(message._id).populate('sender receiver', 'name email role');
      return res.status(201).json(populated);
    } catch (err) {
      return res.status(500).json({ message: 'Error sending client chat message' });
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
      const studentId = req.query.studentId || (await Task.findById(taskId)).student;
      const adminId = toObjectIdString(req.user.id);

      const messages = await Message.find({
        task: taskId,
        student: studentId,
        $or: [
          { sender: adminId, receiver: studentId },
          { sender: studentId, receiver: adminId },
        ],
      })
        .populate('sender receiver', 'name email role')
        .sort({ createdAt: 1 });

      return res.json(messages);
    } catch (err) {
      return res.status(500).json({ message: 'Error loading student chat messages' });
    }
  }
);

router.post(
  '/tasks/:id/chat/student/messages',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { error, value } = adminMessageSchema.validate(req.body);
      const sid = value.studentId || (await Task.findById(req.params.id)).student;

      const message = await Message.create({
        task: req.params.id,
        sender: req.user.id,
        receiver: sid,
        student: sid,
        text: clean(value.text),
        fileUrl: clean(value.fileUrl),
        fileName: clean(value.fileName),
      });

      const populated = await Message.findById(message._id).populate('sender receiver', 'name email role');
      return res.status(201).json(populated);
    } catch (err) {
      return res.status(500).json({ message: 'Error sending student chat message' });
    }
  }
);

// =========================================================
// DASHBOARD / STATS / PAYMENTS (RESTORED 100% & MODIFIED)
// =========================================================

router.get('/stats/overview', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [totalUsers, totalClients, totalStudents, totalTasks, openTasks, assignedTasks, underReviewTasks, completedTasks, declinedTasks, totalPayments, pendingPayments, completedPayments] = await Promise.all([
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
      Payment.countDocuments({ status: { $in: ['created', 'awaiting_advance'] } }),
      Payment.countDocuments({ status: 'completed' }),
    ]);

    const amounts = await Payment.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]);

    return res.json({
      users: { total: totalUsers, clients: totalClients, students: totalStudents },
      tasks: { total: totalTasks, open: openTasks, assigned: assignedTasks, underReview: underReviewTasks, completed: completedTasks, declined: declinedTasks },
      payments: { totalCount: totalPayments, pendingCount: pendingPayments, completedCount: completedPayments, totalAmount: amounts[0]?.total || 0 }
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error loading overview stats' });
  }
});

router.get('/payments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const status = clean(req.query.status);
    const filter = status ? { status } : {};
    const payments = await Payment.find(filter).populate('student', 'name email').populate('task', 'title status').sort({ createdAt: -1 });
    return res.json(payments);
  } catch (err) {
    return res.status(500).json({ message: 'Error loading payments' });
  }
});

/**
 * MODIFIED: TASK PAYMENT OVERRIDE
 * BACKUP Module: Admin records an offline payment and triggers status updates
 */
router.post('/tasks/:id/record-manual-payment', verifyJWT, ensureAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { type, note } = req.body;
    const task = await Task.findById(req.params.id).session(session);
    const payment = await Payment.findOne({ task: task._id }).session(session);

    if (type === 'advance') {
      payment.advance.status = 'paid';
      payment.advance.method = 'manual';
      payment.advance.paidAt = new Date();
      payment.status = 'partially_paid';
      task.status = 'assigned'; 
    } else {
      payment.final.status = 'paid';
      payment.final.method = 'manual';
      payment.final.paidAt = new Date();
      payment.status = 'completed';
      task.status = 'completed';

      // Credit Student virtual wallet immediately
      const student = await User.findById(task.student).session(session);
      student.wallet += (payment.netToStudent || task.budget);
      student.tasksCompleted += 1;
      await student.save({ session });
    }
    payment.adminNote = note;
    await payment.save({ session });
    await task.save({ session });

    await session.commitTransaction();
    return res.json({ message: 'Manual payment recorded successfully', task });
  } catch (err) {
    await session.abortTransaction();
    return res.status(500).json({ message: 'Override failed', error: err.message });
  } finally {
    session.endSession();
  }
});

/**
 * FETCH PENDING VERIFICATIONS
 * Now includes full bank details and the new payment gates
 */
router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const payments = await Payment.find({
      status: { $in: ['awaiting_advance', 'partially_paid', 'approved'] },
    })
      .populate('student', 'name email bankAccountHolderName bankName bankAccountNumber ifscCode')
      .populate('task', 'title status budget')
      .sort({ createdAt: -1 });

    return res.json(payments);
  } catch (err) {
    return res.status(500).json({ message: 'Error loading pending payments' });
  }
});

router.post('/releasePayment/:id', verifyJWT, ensureAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const payment = await Payment.findById(req.params.id).session(session);
    if (!payment || payment.status === 'completed') throw new Error('Invalid payment');

    const student = await User.findById(payment.student).session(session);
    const amount = payment.netToStudent || payment.amount;

    student.wallet += amount;
    student.pendingEarnings = Math.max(0, student.pendingEarnings - amount);
    student.totalEarningsReleased += amount;
    await student.save({ session });

    payment.status = 'completed';
    payment.releasedAt = new Date();
    await payment.save({ session });

    await session.commitTransaction();
    return res.json({ message: 'Released', payment });
  } catch (err) {
    await session.abortTransaction();
    return res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

// =========================================================
// ANALYTICS & GROWTH (RESTORED 100% FROM ORIGINAL)
// =========================================================

router.get('/getTaskStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const byStatus = await Task.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const byCompany = await Task.aggregate([{ $match: { company: { $ne: null } } }, { $group: { _id: '$company', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 20 }]);
    return res.json({ byStatus, byCompany });
  } catch (err) { return res.status(500).json({ message: 'Error loading stats' }); }
});

router.get('/getDomainStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const tasksByDomain = await Task.aggregate([{ $group: { _id: '$domain', tasks: { $sum: 1 } } }]);
    const studentsByDomain = await User.aggregate([{ $match: { role: 'student' } }, { $group: { _id: '$domain', students: { $sum: 1 } } }]);
    return res.json({ tasksByDomain, studentsByDomain });
  } catch (err) { return res.status(500).json({ message: 'Error loading domain stats' }); }
});

router.get('/getTimeSeriesStats', verifyJWT, ensureAdmin, async (req, res) => {
  const since = new Date(); since.setDate(since.getDate() - 90);
  const tasks = await Task.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } }, count: { $sum: 1 } } }, { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }]);
  return res.json({ tasks });
});

router.get('/stats/growth', verifyJWT, ensureAdmin, async (req, res) => {
  const metric = clean(req.query.metric) || 'tasks';
  const granularity = clean(req.query.granularity) || 'month';
  const dateProj = granularity === 'day' ? { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } } : { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } };
  let coll = metric === 'students' ? User : metric === 'payments' ? Payment : Task;
  const growth = await coll.aggregate([{ $group: { _id: dateProj, count: { $sum: 1 } } }, { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }]);
  return res.json(growth);
});

module.exports = router;