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
    return res.status(403).json({ message: 'Admin only' });
  }
  next();
};

// =========================================================
// JOI SCHEMAS
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

// =========================================================
// USERS MANAGEMENT
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

    const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ message: 'Error loading users', error: err.message });
  }
});

router.patch('/users/:id/approve', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { error, value } = approveUserSchema.validate(req.body);
    if (error) return res.status(400).json({ message: 'Validation error' });

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isApproved: value.isApproved },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json({ message: 'Status updated', user });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// =========================================================
// TASKS & WORKFLOW
// =========================================================

router.get('/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { error, value } = adminTaskFilterSchema.validate(req.query, { stripUnknown: true });
    const filter = {};
    if (value.company) filter.company = clean(value.company);
    if (value.location) filter.location = clean(value.location);
    if (value.domain) filter.domain = clean(value.domain);
    if (value.status) filter.status = clean(value.status);

    const tasks = await Task.find(filter)
      .populate('client', 'name email company')
      .populate('student', 'name email skills')
      .populate('requestedStudent', 'name email')
      .populate('assignedByAdmin', 'name email')
      .sort({ createdAt: -1 });
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Error loading tasks' }); }
});

router.post('/tasks/:id/assign', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { studentId } = req.body;
    const task = await Task.findById(req.params.id);
    if (!task || task.status !== 'open') return res.status(400).json({ message: 'Invalid state' });

    task.requestedStudent = studentId;
    task.assignmentRequestStatus = 'request_sent';
    task.assignedByAdmin = req.user.id;
    await task.save();

    await sendNotification(studentId, {
      title: 'New Work Invitation',
      body: `Review invitation for "${task.title}"`,
      data: { type: 'task_request', taskId: task._id.toString() }
    });
    return res.json({ message: 'Invitation sent', task });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/tasks/:id/candidates', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    const match = { role: 'student', isApproved: true };
    if (task.requiredSkills?.length > 0) match.skills = { $in: task.requiredSkills };
    else if (task.domain) match.domain = task.domain;

    const students = await User.aggregate([
      { $match: match },
      { $addFields: { averageScore: { $cond: [{ $gt: ['$totalScoreCount', 0] }, { $divide: ['$totalScore', '$totalScoreCount'] }, 0] } } },
      { $sort: { averageScore: -1, tasksCompleted: -1 } },
      { $limit: 50 },
      { $project: { name: 1, email: 1, skills: 1, tasksCompleted: 1, totalScore: 1, totalScoreCount: 1, averageScore: 1, wallet: 1, domain: 1 } }
    ]);
    return res.json(students);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// WITHDRAWALS MANAGEMENT
// =========================================================

router.get('/withdrawals', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const filter = status ? { status } : {};
    const requests = await Withdrawal.find(filter).populate('student', 'name email wallet').sort({ createdAt: -1 });
    return res.json(requests);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.patch('/withdrawals/:id', verifyJWT, ensureAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { error, value } = withdrawalStatusSchema.validate(req.body);
    if (error) throw new Error(error.details[0].message);

    const withdrawal = await Withdrawal.findById(req.params.id).session(session);
    if (!withdrawal || withdrawal.status !== 'pending') throw new Error('Invalid request');

    const student = await User.findById(withdrawal.student).session(session);

    if (value.status === 'rejected') {
      student.wallet += withdrawal.amount; // Refund balance
      await student.save({ session });
    }

    withdrawal.status = value.status;
    withdrawal.adminNote = value.adminNote;
    withdrawal.processedAt = new Date();
    await withdrawal.save({ session });

    await session.commitTransaction();
    return res.json({ message: 'Success', withdrawal });
  } catch (err) {
    await session.abortTransaction();
    return res.status(400).json({ message: err.message });
  } finally { session.endSession(); }
});

// =========================================================
// ANALYTICS & DASHBOARD (FIXED 404 & DETAILED OVERVIEW)
// =========================================================

router.get('/getTaskFunnelStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const funnel = await Task.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    return res.json({ funnel });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

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

    const amounts = await Payment.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    return res.json({
      users: { total: uAll, clients: uCli, students: uStu },
      tasks: { total: tAll },
      payments: { totalCount: pAll, completedCount: pCom, completedAmount: amounts[0]?.total || 0 }
    });
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

// =========================================================
// PAYMENTS & MANUAL OVERRIDES (RESTORED)
// =========================================================

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
    return res.json({ message: 'Recorded', task });
  } catch (err) { await session.abortTransaction(); return res.status(500).json({ message: 'Error' }); }
  finally { session.endSession(); }
});

router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  const p = await Payment.find({ status: { $in: ['awaiting_advance', 'partially_paid', 'approved'] } })
    .populate('student', 'name email bankAccountNumber ifscCode').populate('task', 'title budget status');
  res.json(p);
});

router.post('/releasePayment/:id', verifyJWT, ensureAdmin, async (req, res) => {
  const pay = await Payment.findById(req.params.id);
  pay.status = 'completed'; pay.releasedAt = new Date();
  await pay.save();
  res.json({ message: 'Released' });
});

router.get('/getTopStudents', verifyJWT, ensureAdmin, async (req, res) => {
  const top = await User.find({ role: 'student' }).sort({ wallet: -1 }).limit(10);
  res.json(top);
});

router.get('/getDomainStats', verifyJWT, ensureAdmin, async (req, res) => {
  const t = await Task.aggregate([{ $group: { _id: '$domain', tasks: { $sum: 1 } } }]);
  const s = await User.aggregate([{ $match: { role: 'student' } }, { $group: { _id: '$domain', students: { $sum: 1 } } }]);
  return res.json({ tasksByDomain: t, studentsByDomain: s });
});

// =========================================================
// TRIANGULAR CHAT ROUTES (RESTORED)
// =========================================================

router.get('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const t = await Task.findById(req.params.id);
  const m = await Message.find({ task: req.params.id, $or: [{ sender: req.user.id, receiver: t.client }, { sender: t.client, receiver: req.user.id }] }).populate('sender receiver', 'name role').sort({ createdAt: 1 });
  res.json(m);
});

router.post('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const t = await Task.findById(req.params.id);
  const m = await Message.create({ task: req.params.id, sender: req.user.id, receiver: t.client, text: req.body.text });
  res.status(201).json(m);
});

router.get('/tasks/:id/chat/student/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const m = await Message.find({ task: req.params.id, student: req.query.studentId }).populate('sender receiver', 'name role').sort({ createdAt: 1 });
  res.json(m);
});

router.post('/tasks/:id/chat/student/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const m = await Message.create({ task: req.params.id, sender: req.user.id, receiver: req.body.studentId, student: req.body.studentId, text: req.body.text });
  res.status(201).json(m);
});

module.exports = router;