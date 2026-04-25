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
const { sendNotification } = require('../utils/fcm'); // For the workflow notification

// =========================================================
// HELPERS (RESTORED ALL ORIGINAL LOGIC)
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
// JOI SCHEMAS (RESTORED ALL ORIGINAL LOGIC)
// =========================================================

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
// USERS (RESTORED ALL ORIGINAL LOGIC)
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
// TASKS & THE NEW "TICK" WORKFLOW (MODIFIED LOGIC)
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
      .populate('requestedStudent', 'name email') // Workflow field
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

      // Workflow Check: Must be open to receive a new request
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
      // task.status remains 'open' until student accepts

      await task.save();

      // Trigger FCM Notification to Student
      await sendNotification(student._id, {
        title: 'New Work Request',
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
      console.error('Error in task request:', err);
      return res.status(500).json({
        message: 'Error processing request',
        error: err.message,
      });
    }
  }
);

// =========================================================
// ADMIN MESSAGES (RESTORED ALL ORIGINAL LOGIC)
// =========================================================

router.get('/tasks/:id/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const taskId = normalizeId(req.params.id);
    const studentId = normalizeId(req.query.studentId);
    if (!taskId || !isValidObjectId(taskId)) return res.status(400).json({ message: 'Valid ID required' });

    const filter = { task: taskId };
    if (studentId) filter.student = studentId;

    const messages = await Message.find(filter)
      .populate('sender receiver', 'name email role')
      .sort({ createdAt: 1 });

    return res.json(messages);
  } catch (err) {
    return res.status(500).json({ message: 'Error loading messages' });
  }
});

router.get('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    const clientId = toObjectIdString(task.client);
    const adminId = toObjectIdString(req.user.id);

    const messages = await Message.find({
      task: req.params.id,
      $or: [{ sender: adminId, receiver: clientId }, { sender: clientId, receiver: adminId }],
    }).populate('sender receiver', 'name email role').sort({ createdAt: 1 });

    return res.json(messages);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.post('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { error, value } = adminMessageSchema.validate(req.body);
    const task = await Task.findById(req.params.id);
    const message = await Message.create({
      task: req.params.id,
      sender: req.user.id,
      receiver: task.client,
      student: value.studentId || task.student,
      text: clean(value.text),
      fileUrl: clean(value.fileUrl),
      fileName: clean(value.fileName)
    });
    return res.status(201).json(message);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/tasks/:id/chat/student/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const studentId = req.query.studentId || (await Task.findById(req.params.id)).student;
    const adminId = toObjectIdString(req.user.id);

    const messages = await Message.find({
      task: req.params.id,
      student: studentId,
      $or: [{ sender: adminId, receiver: studentId }, { sender: studentId, receiver: adminId }],
    }).populate('sender receiver', 'name email role').sort({ createdAt: 1 });

    return res.json(messages);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.post('/tasks/:id/chat/student/messages', verifyJWT, ensureAdmin, async (req, res) => {
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
      fileName: clean(value.fileName)
    });
    return res.status(201).json(message);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// DASHBOARD / STATS / PAYMENTS (RESTORED ALL ORIGINAL LOGIC)
// =========================================================

router.get('/stats/overview', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [totalUsers, totalClients, totalStudents, totalTasks, openTasks, assignedTasks, underReviewTasks, completedTasks, declinedTasks, totalPayments, pendingPayments, completedPayments] = await Promise.all([
      User.countDocuments({}), User.countDocuments({ role: 'client' }), User.countDocuments({ role: 'student' }),
      Task.countDocuments({}), Task.countDocuments({ status: 'open' }), Task.countDocuments({ status: 'assigned' }),
      Task.countDocuments({ status: 'under_review' }), Task.countDocuments({ status: 'completed' }), Task.countDocuments({ status: 'declined' }),
      Payment.countDocuments({}), Payment.countDocuments({ status: { $in: ['created', 'held'] } }), Payment.countDocuments({ status: 'completed' })
    ]);

    const amounts = await Payment.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]);

    return res.json({
      users: { total: totalUsers, clients: totalClients, students: totalStudents },
      tasks: { total: totalTasks, open: openTasks, assigned: assignedTasks, underReview: underReviewTasks, completed: completedTasks, declined: declinedTasks },
      payments: { totalCount: totalPayments, pendingCount: pendingPayments, completedCount: completedPayments, totalAmount: amounts[0]?.total || 0 }
    });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/payments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const filter = req.query.status ? { status: clean(req.query.status) } : {};
    const payments = await Payment.find(filter).populate('student', 'name email').populate('task', 'title status').sort({ createdAt: -1 });
    return res.json(payments);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

/**
 * MODIFIED: GET PENDING PAYMENTS
 * Fixed: Now populates full bank details for the Admin to verify
 */
router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const payments = await Payment.find({ status: { $in: ['created', 'held', 'approved'] } })
      .populate('student', 'name email bankAccountHolderName bankName bankAccountNumber ifscCode')
      .populate('task', 'title status budget')
      .sort({ createdAt: -1 });

    return res.json(payments);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
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
    return res.json({ message: 'Payment released', payment });
  } catch (err) {
    await session.abortTransaction();
    return res.status(400).json({ message: err.message });
  } finally { session.endSession(); }
});

// =========================================================
// ANALYTICS & GROWTH (RESTORED ALL ORIGINAL LOGIC)
// =========================================================

router.get('/getTaskStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const byStatus = await Task.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const byCompany = await Task.aggregate([{ $match: { company: { $ne: null } } }, { $group: { _id: '$company', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 20 }]);
    return res.json({ byStatus, byCompany });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/getDomainStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const tasks = await Task.aggregate([{ $group: { _id: '$domain', tasks: { $sum: 1 } } }]);
    const students = await User.aggregate([{ $match: { role: 'student' } }, { $group: { _id: '$domain', students: { $sum: 1 } } }]);
    return res.json({ tasksByDomain: tasks, studentsByDomain: students });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/getTopStudents', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const top = await User.aggregate([
      { $match: { role: 'student', isApproved: true } },
      { $addFields: { averageScore: { $cond: [{ $gt: ['$totalScoreCount', 0] }, { $divide: ['$totalScore', '$totalScoreCount'] }, 0] } } },
      { $project: { name: 1, email: 1, tasksCompleted: 1, averageScore: 1, wallet: 1, domain: 1 } },
      { $sort: { averageScore: -1, tasksCompleted: -1 } }, { $limit: 20 }
    ]);
    return res.json(top);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/getTimeSeriesStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const since = new Date(); since.setDate(since.getDate() - 90);
    const tasks = await Task.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } }, count: { $sum: 1 } } }, { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }]);
    return res.json({ tasks });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/stats/growth', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const metric = clean(req.query.metric) || 'tasks';
    const granularity = clean(req.query.granularity) || 'month';
    const dateProj = granularity === 'day' ? { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } } : { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } };
    let coll = metric === 'students' ? User : metric === 'payments' ? Payment : Task;
    const growth = await coll.aggregate([{ $group: { _id: dateProj, count: { $sum: 1 } } }, { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }]);
    return res.json(growth);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

module.exports = router;