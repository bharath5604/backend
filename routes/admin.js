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
    return value._id.toString();
  }
  return String(value).trim();
}

function isValidObjectId(value) {
  if (!value) return false;
  return mongoose.Types.ObjectId.isValid(value);
}

const ensureAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin only' });
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

// =========================================================
// 1. DASHBOARD ANALYTICS (TOP PRIORITY STATIC ROUTES)
// =========================================================

/**
 * GET /api/admin/getTaskStats
 * FIXED: Resolves 404 for Dashboard
 */
router.get('/getTaskStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const stats = await Task.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    return res.json({ byStatus: stats });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

/**
 * GET /api/admin/getTaskFunnelStats
 * FIXED: Resolves 404 for Dashboard
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
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
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
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// 2. RESOURCE LISTS
// =========================================================

router.get('/users', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const role = clean(req.query.role);
    const filter = role ? { role } : {};
    const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
    return res.json(users);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const tasks = await Task.find({}).populate('client student requestedStudent').sort({ createdAt: -1 });
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/withdrawals', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const requests = await Withdrawal.find({}).populate('student').sort({ createdAt: -1 });
    return res.json(requests);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const p = await Payment.find({ status: { $in: ['awaiting_advance', 'partially_paid', 'approved'] } })
      .populate('student', 'name email bankAccountNumber ifscCode bankAccountHolderName bankName')
      .populate('task', 'title budget status');
    return res.json(p);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// 3. ANALYTICS & CHARTS
// =========================================================

router.get('/getTopStudents', verifyJWT, ensureAdmin, async (req, res) => {
  const top = await User.find({ role: 'student' }).sort({ wallet: -1 }).limit(10);
  res.json(top);
});

router.get('/getTimeSeriesStats', verifyJWT, ensureAdmin, async (req, res) => {
  const tasks = await Task.aggregate([{ $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } }, count: { $sum: 1 } } }]);
  res.json({ tasks });
});

router.get('/getDomainStats', verifyJWT, ensureAdmin, async (req, res) => {
  const t = await Task.aggregate([{ $group: { _id: '$domain', tasks: { $sum: 1 } } }]);
  const s = await User.aggregate([{ $match: { role: 'student' } }, { $group: { _id: '$domain', students: { $sum: 1 } } }]);
  res.json({ tasksByDomain: t, studentsByDomain: s });
});

router.get('/stats/growth', verifyJWT, ensureAdmin, async (req, res) => {
  const metric = req.query.metric || 'tasks';
  let coll = metric === 'students' ? User : metric === 'payments' ? Payment : Task;
  const growth = await coll.aggregate([{ $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } }, { $sort: { '_id.year': 1, '_id.month': 1 } }]);
  res.json(growth);
});

// =========================================================
// 4. ACTION ROUTES (PARAMETERIZED)
// =========================================================

router.patch('/users/:id/approve', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { value } = approveUserSchema.validate(req.body);
    const user = await User.findByIdAndUpdate(req.params.id, { isApproved: value.isApproved }, { new: true });
    return res.json({ message: 'Updated', user });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.post('/tasks/:id/assign', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { value } = assignStudentSchema.validate(req.body);
    const task = await Task.findById(req.params.id);
    task.requestedStudent = value.studentId;
    task.assignmentRequestStatus = 'request_sent';
    await task.save();
    await sendNotification(value.studentId, { title: 'Invitation', body: `Task: ${task.title}`, data: { type: 'task_request', taskId: task._id.toString() } });
    return res.json({ message: 'Sent', task });
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
    return res.json({ message: 'Success' });
  } catch (err) { await session.abortTransaction(); return res.status(500).json({ message: 'Error' }); }
  finally { session.endSession(); }
});

router.patch('/withdrawals/:id', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { value } = withdrawalStatusSchema.validate(req.body);
    const w = await Withdrawal.findByIdAndUpdate(req.params.id, { status: value.status, adminNote: value.adminNote, processedAt: new Date() }, { new: true });
    return res.json({ message: 'Updated', w });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.post('/releasePayment/:id', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const pay = await Payment.findById(req.params.id);
    pay.status = 'completed'; pay.releasedAt = new Date(); await pay.save();
    return res.json({ message: 'Released' });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// 5. TRIANGULAR MESSAGING
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