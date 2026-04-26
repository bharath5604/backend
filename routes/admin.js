// backend/routes/admin.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Joi = require('joi');

const User = require('../models/User');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const Message = require('../models/Message');
const Withdrawal = require('../models/Withdrawal'); // NEW MODEL REQUIRED

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
  assignmentStatus: Joi.string()
    .valid('unassigned', 'request_sent', 'accepted', 'rejected', 'cancelled', 'expired')
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

    const users = await User.find(filter).select('-password');
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ message: 'Error loading users', error: err.message });
  }
});

router.patch('/users/:id/approve', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { error, value } = approveUserSchema.validate(req.body);
    if (error) return res.status(400).json({ message: 'Validation error', details: error.details.map((d) => d.message) });

    const user = await User.findByIdAndUpdate(req.params.id, { isApproved: value.isApproved }, { new: true, runValidators: true }).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json({ message: 'Approval updated', user });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// =========================================================
// TASKS & WORKFLOW (TICK REQUESTS)
// =========================================================

router.get('/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { error, value } = adminTaskFilterSchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ message: 'Validation error' });

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
  } catch (err) {
    return res.status(500).json({ message: 'Error loading tasks' });
  }
});

router.get('/tasks/filters', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [companies, locations, domains] = await Promise.all([
      Task.distinct('company'), Task.distinct('location'), Task.distinct('domain')
    ]);
    return res.json({
      companies: companies.filter(Boolean),
      locations: locations.filter(Boolean),
      domains: domains.filter(Boolean)
    });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.post('/tasks/:id/assign', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { error, value } = assignStudentSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const task = await Task.findById(req.params.id);
    if (!task || task.status !== 'open') return res.status(400).json({ message: 'Invalid task state' });

    const student = await User.findById(value.studentId);
    if (!student || student.role !== 'student' || !student.isApproved) return res.status(400).json({ message: 'Invalid student' });

    task.requestedStudent = student._id;
    task.assignmentRequestStatus = 'request_sent';
    task.requestSentAt = new Date();
    task.assignedByAdmin = req.user.id;

    await task.save();

    await sendNotification(student._id, {
      title: 'New Work Invitation',
      body: `You have been invited to work on "${task.title}".`,
      data: { type: 'task_request', taskId: task._id.toString() }
    });

    return res.json({ message: 'Assignment request sent', task });
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
      { $sort: { averageScore: -1, tasksCompleted: -1, createdAt: -1 } },
      { $limit: 50 },
      { $project: { name: 1, email: 1, skills: 1, tasksCompleted: 1, totalScore: 1, totalScoreCount: 1, averageScore: 1, wallet: 1, domain: 1 } }
    ]);
    return res.json(students);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// WITHDRAWAL MANAGEMENT (NEW)
// =========================================================

router.get('/withdrawals', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const filter = status ? { status } : {};
    const requests = await Withdrawal.find(filter).populate('student', 'name email wallet').sort({ createdAt: -1 });
    return res.json(requests);
  } catch (err) { return res.status(500).json({ message: 'Error loading withdrawals' }); }
});

router.patch('/withdrawals/:id', verifyJWT, ensureAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { error, value } = withdrawalStatusSchema.validate(req.body);
    if (error) throw new Error(error.details[0].message);

    const withdrawal = await Withdrawal.findById(req.params.id).session(session);
    if (!withdrawal || withdrawal.status !== 'pending') throw new Error('Request already processed');

    const student = await User.findById(withdrawal.student).session(session);

    if (value.status === 'rejected') {
      student.wallet += withdrawal.amount; // Refund wallet
      await student.save({ session });
    }

    withdrawal.status = value.status;
    withdrawal.adminNote = value.adminNote;
    withdrawal.processedAt = new Date();
    await withdrawal.save({ session });

    await session.commitTransaction();

    await sendNotification(student._id, {
      title: `Withdrawal ${value.status.toUpperCase()}`,
      body: value.status === 'processed' ? `₹${withdrawal.amount} has been sent to your bank.` : `Request for ₹${withdrawal.amount} was rejected. Funds refunded.`,
      data: { type: 'withdrawal_update' }
    });

    return res.json({ message: `Success: ${value.status}`, withdrawal });
  } catch (err) {
    await session.abortTransaction();
    return res.status(400).json({ message: err.message });
  } finally { session.endSession(); }
});

// =========================================================
// MESSAGES (TRIANGULAR CHAT - RESTORED)
// =========================================================

router.get('/tasks/:id/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const filter = { task: req.params.id };
    if (req.query.studentId) filter.student = req.query.studentId;
    const messages = await Message.find(filter).populate('sender receiver', 'name email role').sort({ createdAt: 1 });
    return res.json(messages);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    const messages = await Message.find({
      task: req.params.id,
      $or: [{ sender: req.user.id, receiver: task.client }, { sender: task.client, receiver: req.user.id }]
    }).populate('sender receiver', 'name email role').sort({ createdAt: 1 });
    return res.json(messages);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.post('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    const message = await Message.create({
      task: req.params.id, sender: req.user.id, receiver: task.client,
      text: clean(req.body.text), fileUrl: clean(req.body.fileUrl), fileName: clean(req.body.fileName)
    });
    return res.status(201).json(message);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/tasks/:id/chat/student/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const sid = req.query.studentId;
    const messages = await Message.find({
      task: req.params.id, student: sid,
      $or: [{ sender: req.user.id, receiver: sid }, { sender: sid, receiver: req.user.id }]
    }).populate('sender receiver', 'name email role').sort({ createdAt: 1 });
    return res.json(messages);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.post('/tasks/:id/chat/student/messages', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const sid = req.body.studentId;
    const message = await Message.create({
      task: req.params.id, sender: req.user.id, receiver: sid, student: sid,
      text: clean(req.body.text), fileUrl: clean(req.body.fileUrl), fileName: clean(req.body.fileName)
    });
    return res.status(201).json(message);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// PAYMENTS & STATS (RESTORED & MODIFIED)
// =========================================================

router.get('/stats/overview', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [u, c, s, t, o, a, ur, com, dec, pAll, pPen, pCo] = await Promise.all([
      User.countDocuments({}), User.countDocuments({ role: 'client' }), User.countDocuments({ role: 'student' }),
      Task.countDocuments({}), Task.countDocuments({ status: 'open' }), Task.countDocuments({ status: 'assigned' }),
      Task.countDocuments({ status: 'under_review' }), Task.countDocuments({ status: 'completed' }), Task.countDocuments({ status: 'declined' }),
      Payment.countDocuments({}), Payment.countDocuments({ status: { $in: ['created', 'awaiting_advance'] } }), Payment.countDocuments({ status: 'completed' })
    ]);
    return res.json({
      users: { total: u, clients: c, students: s },
      tasks: { total: t, open: o, assigned: a, underReview: ur, completed: com, declined: dec },
      payments: { totalCount: pAll, pendingCount: pPen, completedCount: pCo }
    });
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
      payment.advance.status = 'paid'; payment.advance.method = 'manual';
      payment.advance.paidAt = new Date(); payment.status = 'partially_paid';
      task.status = 'assigned'; 
    } else {
      payment.final.status = 'paid'; payment.final.method = 'manual';
      payment.final.paidAt = new Date(); payment.status = 'completed';
      task.status = 'completed';
      const student = await User.findById(task.student).session(session);
      student.wallet += (payment.netToStudent || task.budget);
      student.tasksCompleted += 1;
      await student.save({ session });
    }
    payment.adminNote = note; await payment.save({ session }); await task.save({ session });
    await session.commitTransaction();
    return res.json({ message: 'Payment recorded', task });
  } catch (err) { await session.abortTransaction(); return res.status(500).json({ message: 'Error' }); }
  finally { session.endSession(); }
});

router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const p = await Payment.find({ status: { $in: ['awaiting_advance', 'partially_paid', 'approved'] } })
      .populate('student', 'name email bankAccountHolderName bankName bankAccountNumber ifscCode')
      .populate('task', 'title status budget')
      .sort({ createdAt: -1 });
    return res.json(p);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.post('/releasePayment/:id', verifyJWT, ensureAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const pay = await Payment.findById(req.params.id).session(session);
    const stud = await User.findById(pay.student).session(session);
    const amt = pay.netToStudent || pay.amount;
    stud.wallet += amt; stud.pendingEarnings = Math.max(0, stud.pendingEarnings - amt);
    stud.totalEarningsReleased += amt; await stud.save({ session });
    pay.status = 'completed'; pay.releasedAt = new Date(); await pay.save({ session });
    await session.commitTransaction();
    return res.json({ message: 'Released', pay });
  } catch (err) { await session.abortTransaction(); return res.status(400).json({ message: 'Error' }); }
  finally { session.endSession(); }
});

// =========================================================
// ANALYTICS (RESTORED 100%)
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

router.get('/getTimeSeriesStats', verifyJWT, ensureAdmin, async (req, res) => {
  const since = new Date(); since.setDate(since.getDate() - 90);
  const tasks = await Task.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } }, count: { $sum: 1 } } }, { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }]);
  return res.json({ tasks });
});

router.get('/stats/growth', verifyJWT, ensureAdmin, async (req, res) => {
  const metric = req.query.metric || 'tasks';
  const granularity = req.query.granularity || 'month';
  const dateProj = granularity === 'day' ? { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } } : { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } };
  let coll = metric === 'students' ? User : metric === 'payments' ? Payment : Task;
  const growth = await coll.aggregate([{ $group: { _id: dateProj, count: { $sum: 1 } } }, { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }]);
  return res.json(growth);
});

module.exports = router;