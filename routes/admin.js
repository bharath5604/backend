// backend/routes/admin.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Joi = require('joi');

const User = require('../models/User');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const Message = require('../models/Message');
const Withdrawal = require('../models/Withdrawal');

const verifyJWT = require('../middleware/authMiddleware');
const { sendNotification } = require('../utils/fcm');

// =========================================================
// HELPERS (RESTORED 100%)
// =========================================================

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeId(value) {
  return clean(value);
}

function toObjectIdString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (typeof value === 'object' && value._id) {
    if (value._id instanceof mongoose.Types.ObjectId) return value._id.toString();
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
// JOI SCHEMAS (RESTORED 100%)
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
});

const assignStudentSchema = Joi.object({
  studentId: Joi.string().required(),
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

const acceptRequestSchema = Joi.object({
  agreedToTerms: Joi.boolean().required(),
});

// =========================================================
// 1. DASHBOARD ANALYTICS (TOP PRIORITY - STATIC PATHS FIRST)
// =========================================================

/**
 * GET /api/admin/getTopStudents
 * FIXED: Moved to top to resolve 404 error
 */
router.get('/getTopStudents', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const top = await User.find({ role: 'student' })
      .select('name email wallet tasksCompleted')
      .sort({ wallet: -1 })
      .limit(10);
    return res.json(top);
  } catch (err) {
    return res.status(500).json({ message: 'Error loading top students' });
  }
});

/**
 * GET /api/admin/getTaskStats
 * FIXED: Moved to top to resolve 404 error
 */
router.get('/getTaskStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const stats = await Task.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    return res.json({ byStatus: stats });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

/**
 * GET /api/admin/getTaskFunnelStats
 * FIXED: Moved to top to resolve 404 error
 */
router.get('/getTaskFunnelStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const funnel = await Task.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    return res.json({ funnel });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

/**
 * GET /api/admin/stats/overview
 * Breakdown: Total Users, Students, Clients
 */
router.get('/stats/overview', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [uAll, uCli, uStu, tAll, pAll, pCom] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: 'client' }),
      User.countDocuments({ role: 'student' }),
      Task.countDocuments({}),
      Payment.countDocuments({}),
      Payment.countDocuments({ status: 'completed' })
    ]);

    const payoutAgg = await Payment.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    return res.json({
      users: { total: uAll, clients: uCli, students: uStu },
      tasks: { total: tAll },
      payments: { totalCount: pAll, completedCount: pCom, completedAmount: payoutAgg[0]?.total || 0 }
    });
  } catch (err) { return res.status(500).json({ message: 'Error loading overview' }); }
});

/**
 * GET /api/admin/tasks/filters
 */
router.get('/tasks/filters', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [companies, locations, domains] = await Promise.all([
      Task.distinct('company'), Task.distinct('location'), Task.distinct('domain')
    ]);
    return res.json({ companies: companies.filter(Boolean), locations: locations.filter(Boolean), domains: domains.filter(Boolean) });
  } catch (err) { return res.status(500).json({ message: 'Error loading filters' }); }
});

// =========================================================
// 2. RESOURCE MANAGEMENT (LISTS)
// =========================================================

router.get('/users', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const role = clean(req.query.role);
    const filter = role ? { role } : {};
    const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
    return res.json(users);
  } catch (err) { return res.status(500).json({ message: 'Error loading users' }); }
});

router.get('/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { status, domain } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (domain) filter.domain = domain;

    const tasks = await Task.find(filter)
      .populate('client student requestedStudent')
      .sort({ createdAt: -1 });
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Error loading tasks' }); }
});

router.get('/withdrawals', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const requests = await Withdrawal.find({}).populate('student').sort({ createdAt: -1 });
    return res.json(requests);
  } catch (err) { return res.status(500).json({ message: 'Error loading withdrawals' }); }
});

router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const p = await Payment.find({ status: { $in: ['awaiting_advance', 'partially_paid', 'approved'] } })
      .populate('student', 'name email bankAccountNumber ifscCode bankAccountHolderName bankName')
      .populate('task', 'title budget status');
    return res.json(p);
  } catch (err) { return res.status(500).json({ message: 'Error fetching payments' }); }
});

router.get('/tasks/:id/candidates', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const match = { role: 'student', isApproved: true };
    if (task.requiredSkills?.length > 0) match.skills = { $in: task.requiredSkills };
    else if (task.domain) match.domain = task.domain;

    const students = await User.aggregate([
      { $match: match },
      { $addFields: { averageScore: { $cond: [{ $gt: ['$totalScoreCount', 0] }, { $divide: ['$totalScore', '$totalScoreCount'] }, 0] } } },
      { $sort: { averageScore: -1, tasksCompleted: -1 } },
      { $project: { name: 1, email: 1, skills: 1, tasksCompleted: 1, totalScore: 1, totalScoreCount: 1, averageScore: 1, wallet: 1, domain: 1 } }
    ]);
    return res.json(students);
  } catch (err) { return res.status(500).json({ message: 'Error loading candidates' }); }
});
// =========================================================
// 3. ACTION ROUTES (PARAMETERIZED - LOWEST PRIORITY)
// =========================================================

router.patch('/users/:id/approve', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { error, value } = approveUserSchema.validate(req.body);
    if (error) return res.status(400).json({ message: 'Validation error' });

    const user = await User.findByIdAndUpdate(req.params.id, { isApproved: value.isApproved }, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json({ message: 'User status updated', user });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});
/**
 * POST /api/tasks/:id/accept-request
 */
router.post('/:id/accept-request', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ message: 'Forbidden' });

    const { error } = acceptRequestSchema.validate(req.body);
    if (error) return res.status(400).json({ message: 'You must agree to the SKILEN terms.' });

    const task = await Task.findById(req.params.id);
    
    // Safety check: Is this student actually the one invited?
    if (!task || task.requestedStudent?.toString() !== req.user.id) {
      return res.status(404).json({ message: 'Invitation not found or expired.' });
    }

    // 1. Create the Payment record (The Gate for the Admin)
    // We create this NOW so it shows up in Admin > Payouts immediately
    try {
      await Payment.create({
        task: task._id,
        client: task.client,
        student: req.user.id,
        totalBudget: task.budget,
        netToStudent: task.budget, // Original logic
        advance: { amount: task.budget * 0.20, status: 'pending' },
        final: { amount: task.budget * 0.80, status: 'pending' },
        status: 'awaiting_advance'
      });
    } catch (payErr) {
      console.error('CRITICAL: Payment Creation Failed:', payErr);
      return res.status(500).json({ message: 'Financial ledger could not be initialized.' });
    }

    // 2. Update the Task Status
    task.student = req.user.id;
    task.studentAgreedToTerms = true;
    task.status = 'awaiting_advance'; 
    task.assignedAt = new Date();
    task.requestedStudent = null;
    task.assignmentRequestStatus = null;

    await task.save();
    
    return res.json({ message: 'Project accepted. Awaiting advance payment.', task });

  } catch (err) {
    console.error('Accept Request Crash:', err);
    return res.status(500).json({ message: 'Server error during acceptance.' });
  }
});
router.post('/tasks/:id/assign', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { value } = assignStudentSchema.validate(req.body);
    const task = await Task.findById(req.params.id);
    if (!task || task.status !== 'open') return res.status(400).json({ message: 'Invalid task state' });

    task.requestedStudent = value.studentId;
    task.assignmentRequestStatus = 'request_sent';
    task.assignedByAdmin = req.user.id;
    await task.save();

    await sendNotification(value.studentId, {
      title: 'New Work Invitation',
      body: `You have been invited to work on "${task.title}".`,
      data: { type: 'task_request', taskId: task._id.toString() }
    });
    return res.json({ message: 'Invitation sent to student', task });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.post('/tasks/:id/record-manual-payment', verifyJWT, ensureAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { type, note } = req.body;
    const task = await Task.findById(req.params.id).session(session);
    const payment = await Payment.findOne({ task: task._id }).session(session);

    if (type === 'advance') {
      payment.advance.status = 'paid'; payment.advance.paidAt = new Date(); payment.status = 'partially_paid';
      task.status = 'assigned'; 
    } else {
      payment.final.status = 'paid'; payment.final.paidAt = new Date(); payment.status = 'completed';
      task.status = 'completed';
      const student = await User.findById(task.student).session(session);
      student.wallet += (payment.netToStudent || task.budget);
      student.tasksCompleted += 1;
      await student.save({ session });
    }
    payment.adminNote = note; await payment.save({ session }); await task.save({ session });
    await session.commitTransaction();
    return res.json({ message: 'Payment recorded manually', task });
  } catch (err) {
    await session.abortTransaction();
    return res.status(500).json({ message: 'Manual override failed', error: err.message });
  } finally { session.endSession(); }
});

router.patch('/withdrawals/:id', verifyJWT, ensureAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status, adminNote } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id).session(session);
    if (!withdrawal || withdrawal.status !== 'pending') throw new Error('Invalid request');

    if (status === 'rejected') {
      const student = await User.findById(withdrawal.student).session(session);
      student.wallet += withdrawal.amount; // Refund
      await student.save({ session });
    }

    withdrawal.status = status;
    withdrawal.adminNote = adminNote;
    withdrawal.processedAt = new Date();
    await withdrawal.save({ session });

    await session.commitTransaction();
    return res.json({ message: 'Withdrawal updated', withdrawal });
  } catch (err) {
    await session.abortTransaction();
    return res.status(400).json({ message: err.message });
  } finally { session.endSession(); }
});

router.post('/releasePayment/:id', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const pay = await Payment.findById(req.params.id);
    if (!pay) return res.status(404).json({ message: 'Payment not found' });
    pay.status = 'completed'; pay.releasedAt = new Date(); await pay.save();
    return res.json({ message: 'Payment released successfully' });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// 4. CHARTS & GROWTH (RESTORED 100%)
// =========================================================

router.get('/getTimeSeriesStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const since = new Date(); since.setDate(since.getDate() - 90);
    const tasks = await Task.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } }, count: { $sum: 1 } } }, { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }]);
    return res.json({ tasks });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/getDomainStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const t = await Task.aggregate([{ $group: { _id: '$domain', tasks: { $sum: 1 } } }]);
    const s = await User.aggregate([{ $match: { role: 'student' } }, { $group: { _id: '$domain', students: { $sum: 1 } } }]);
    return res.json({ tasksByDomain: t, studentsByDomain: s });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/stats/growth', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const metric = clean(req.query.metric) || 'tasks';
    let coll = metric === 'students' ? User : metric === 'payments' ? Payment : Task;
    const growth = await coll.aggregate([{ $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } }, { $sort: { '_id.year': 1, '_id.month': 1 } }]);
    return res.json(growth);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// 5. TRIANGULAR MESSAGING (RESTORED 100%)
// =========================================================

router.get('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const t = await Task.findById(req.params.id);
  const m = await Message.find({ task: req.params.id, $or: [{ sender: req.user.id, receiver: t.client }, { sender: t.client, receiver: req.user.id }] }).populate('sender receiver', 'name role').sort({ createdAt: 1 });
  return res.json(m);
});

router.post('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const { value } = adminMessageSchema.validate(req.body);
  const t = await Task.findById(req.params.id);
  const m = await Message.create({ task: req.params.id, sender: req.user.id, receiver: t.client, text: value.text, fileUrl: value.fileUrl, fileName: value.fileName });
  res.status(201).json(m);
});

router.get('/tasks/:id/chat/student/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const m = await Message.find({ task: req.params.id, student: req.query.studentId, $or: [{ sender: req.user.id, receiver: req.query.studentId }, { sender: req.query.studentId, receiver: req.user.id }] }).populate('sender receiver', 'name role').sort({ createdAt: 1 });
  return res.json(m);
});

router.post('/tasks/:id/chat/student/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const { value } = adminMessageSchema.validate(req.body);
  const m = await Message.create({ task: req.params.id, sender: req.user.id, receiver: value.studentId, student: value.studentId, text: value.text, fileUrl: value.fileUrl, fileName: value.fileName });
  res.status(201).json(m);
});

module.exports = router;