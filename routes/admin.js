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
// HELPERS (FULLY UTILIZED)
// =========================================================

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * FIXED: Sanitizes all route parameters
 */
function normalizeId(value) {
  return clean(value);
}

/**
 * FIXED: Safely resolves IDs for comparisons and logic
 */
function toObjectIdString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (value && value._id) {
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
// JOI SCHEMAS (FULLY UTILIZED)
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
// 1. DASHBOARD ANALYTICS (STATIC PATHS - TOP PRIORITY)
// =========================================================

router.get('/getTopStudents', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const top = await User.find({ role: 'student' }).select('name email wallet tasksCompleted').sort({ wallet: -1 }).limit(10);
    return res.json(top);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/getTaskStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const stats = await Task.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    return res.json({ byStatus: stats });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/getTaskFunnelStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const funnel = await Task.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    return res.json({ funnel });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/stats/overview', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [uAll, uCli, uStu, tAll, pAll, pCom] = await Promise.all([
      User.countDocuments({}), User.countDocuments({ role: 'client' }),
      User.countDocuments({ role: 'student' }), Task.countDocuments({}),
      Payment.countDocuments({}), Payment.countDocuments({ status: 'completed' })
    ]);
    const payoutAgg = await Payment.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    return res.json({
      users: { total: uAll, clients: uCli, students: uStu },
      tasks: { total: tAll },
      payments: { totalCount: pAll, completedCount: pCom, completedAmount: payoutAgg[0]?.total || 0 }
    });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

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
  const role = clean(req.query.role);
  const filter = role ? { role } : {};
  const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
  return res.json(users);
});

router.get('/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  const { error, value } = adminTaskFilterSchema.validate(req.query, { stripUnknown: true });
  if (error) return res.status(400).json({ message: 'Invalid filters' });
  const tasks = await Task.find(value).populate('client student requestedStudent').sort({ createdAt: -1 });
  return res.json(tasks);
});

router.get('/withdrawals', verifyJWT, ensureAdmin, async (req, res) => {
  const requests = await Withdrawal.find({}).populate('student').sort({ createdAt: -1 });
  return res.json(requests);
});

router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
  const p = await Payment.find({ status: { $in: ['awaiting_advance', 'partially_paid', 'approved'] } })
    .populate('student', 'name email bankAccountNumber ifscCode bankAccountHolderName bankName')
    .populate('task', 'title budget status');
  return res.json(p);
});

// =========================================================
// 3. ACTION ROUTES (PARAMETERIZED)
// =========================================================

router.patch('/users/:id/approve', verifyJWT, ensureAdmin, async (req, res) => {
  const targetId = normalizeId(req.params.id);
  const { error, value } = approveUserSchema.validate(req.body);
  if (error) return res.status(400).json({ message: 'Validation failed' });
  
  const user = await User.findByIdAndUpdate(targetId, { isApproved: value.isApproved }, { new: true });
  return res.json({ message: 'Updated', user });
});

router.post('/tasks/:id/assign', verifyJWT, ensureAdmin, async (req, res) => {
  const taskId = normalizeId(req.params.id);
  const { error, value } = assignStudentSchema.validate(req.body);
  if (error) return res.status(400).json({ message: 'ID required' });

  const task = await Task.findById(taskId);
  task.requestedStudent = value.studentId;
  task.assignmentRequestStatus = 'request_sent';
  await task.save();
  await sendNotification(value.studentId, { title: 'New Invitation', body: `Task: ${task.title}`, data: { type: 'task_request', taskId: task._id.toString() } });
  return res.json({ message: 'Sent', task });
});



// backend/routes/admin.js

router.post('/tasks/:id/record-manual-payment', verifyJWT, ensureAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const taskId = normalizeId(req.params.id);
    const { type, note } = req.body;

    const task = await Task.findById(taskId).session(session);
    if (!task) throw new Error('Task not found in database.');

    let payment = await Payment.findOne({ task: taskId }).session(session);
    const resolvedStudentId = payment?.student || task.student || task.requestedStudent;
    
    if (!resolvedStudentId) {
      throw new Error('No student linked to this task.');
    }

    if (!payment) {
      payment = new Payment({
        task: task._id,
        client: task.client,
        student: resolvedStudentId,
        totalBudget: task.budget || 0,
        netToStudent: task.budget || 0,
        status: 'created',
        advance: { amount: (task.budget || 0) * 0.20, status: 'pending' },
        final: { amount: (task.budget || 0) * 0.80, status: 'pending' }
      });
    }

    let student = await User.findById(resolvedStudentId).session(session);

    if (type === 'advance') {
      payment.advance.status = 'paid';
      payment.advance.method = 'manual';
      payment.advance.paidAt = new Date();
      payment.status = 'partially_paid';
      
      task.status = 'assigned'; 
      task.student = resolvedStudentId;
      task.assignedByAdmin = new mongoose.Types.ObjectId(req.user.id); 
      task.assignedAt = new Date();
      task.studentAgreedToTerms = true; 
      
      task.requestedStudent = null;
      task.assignmentRequestStatus = null;
      
    } else {
      payment.final.status = 'paid';
      payment.final.method = 'manual';
      payment.final.paidAt = new Date();
      payment.status = 'completed';
      task.status = 'completed';

      if (student) {
        const amountToCredit = payment.netToStudent || task.budget;
        student.wallet = (student.wallet || 0) + amountToCredit;
        student.tasksCompleted = (student.tasksCompleted || 0) + 1;
        await student.save({ session });
      }
    }

    payment.adminNote = note || 'Verified manually by Admin';
    await payment.save({ session });
    await task.save({ session });

    await session.commitTransaction();

    // ==========================================
    // START REAL-TIME TRIGGERS
    // ==========================================
    const io = req.app.get('socketio');
    if (io) {
      // 1. Notify everyone looking at this task (Admin/Client/Student)
      io.to(taskId).emit('task_update', { 
        taskId, 
        status: task.status,
        message: `Task ${type} payment verified` 
      });

      // 2. Specifically notify the student to refresh their wallet/dashboard
      io.to(resolvedStudentId.toString()).emit('wallet_update', { 
        newBalance: student?.wallet || 0,
        message: 'Your payment has been credited!'
      });
      
      // 3. Optional: Notify Admin to refresh the Payouts/Stats page
      io.emit('admin_stats_update');
    }
    // ==========================================

    return res.json({ 
        message: 'Payment verified successfully', 
        status: task.status 
    });

  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    return res.status(500).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

router.get('/tasks/:id/candidates', verifyJWT, ensureAdmin, async (req, res) => {
    const taskId = normalizeId(req.params.id);
    const task = await Task.findById(taskId);
    const students = await User.find({ 
    role: 'student', 
    isApproved: true, 
    skills: { $in: task.requiredSkills } 
  }).select('name email mobile skills tasksCompleted averageScore');
    return res.json(students);
});

/**
 * PATCH /api/admin/withdrawals/:id
 * FIXED: Now utilizes withdrawalStatusSchema for safe processing
 */

router.patch('/withdrawals/:id', verifyJWT, ensureAdmin, async (req, res) => {
  const wId = normalizeId(req.params.id);
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { error, value } = withdrawalStatusSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const withdrawal = await Withdrawal.findById(wId).session(session);
    
    // Check if exists and is still pending
    if (!withdrawal) throw new Error('Withdrawal request not found');
    if (withdrawal.status !== 'pending') throw new Error('Request already processed');

    if (value.status === 'rejected') {
      const student = await User.findById(withdrawal.student).session(session);
      student.wallet += withdrawal.amount; 
      await student.save({ session });
    }

    withdrawal.status = value.status;
    withdrawal.adminNote = value.adminNote || 'Processed by Admin';
    withdrawal.processedAt = new Date();
    await withdrawal.save({ session });

    await session.commitTransaction();

    // ==========================================
    // REAL-TIME TRIGGER: Notify Student & Admin
    // ==========================================
    const io = req.app.get('socketio');
    if (io) {
      // 1. Notify the student to refresh their dashboard
      io.to(withdrawal.student.toString()).emit('wallet_update', { 
        message: `Your withdrawal of ₹${withdrawal.amount} was ${value.status}` 
      });
      // 2. Notify all admins to refresh the pending list
      io.emit('admin_stats_update'); 
    }

    return res.json({ message: 'Withdrawal processed', withdrawal });
  } catch (err) { 
    if (session.inTransaction()) await session.abortTransaction();
    return res.status(400).json({ message: err.message }); 
  } finally { session.endSession(); }
});

router.post('/releasePayment/:id', verifyJWT, ensureAdmin, async (req, res) => {
  const pId = normalizeId(req.params.id);
  const pay = await Payment.findById(pId);
  pay.status = 'completed'; pay.releasedAt = new Date(); await pay.save();
  return res.json({ message: 'Released' });
});

// =========================================================
// 4. CHARTS & MESSAGING (USING normalization helpers)
// =========================================================

router.get('/getTimeSeriesStats', verifyJWT, ensureAdmin, async (req, res) => {
  const tasks = await Task.aggregate([{ $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } }, count: { $sum: 1 } } }]);
  return res.json({ tasks });
});

router.get('/stats/growth', verifyJWT, ensureAdmin, async (req, res) => {
  const metric = clean(req.query.metric) || 'tasks';
  let coll = metric === 'students' ? User : metric === 'payments' ? Payment : Task;
  const growth = await coll.aggregate([{ $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } }]);
  return res.json(growth);
});

router.get('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const tId = normalizeId(req.params.id);
  const adminId = toObjectIdString(req.user.id);
  const t = await Task.findById(tId);
  const clientId = toObjectIdString(t.client);

  const m = await Message.find({ 
    task: tId, 
    $or: [{ sender: adminId, receiver: clientId }, { sender: clientId, receiver: adminId }] 
  }).populate('sender receiver', 'name role').sort({ createdAt: 1 });
  return res.json(m);
});

router.post('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const tId = normalizeId(req.params.id);
  const { error, value } = adminMessageSchema.validate(req.body);
  if (error) return res.status(400).json({ message: 'Input error' });
  const t = await Task.findById(tId);
  
  const m = await Message.create({ 
    task: tId, sender: req.user.id, receiver: t.client, 
    text: value.text, fileUrl: value.fileUrl, fileName: value.fileName 
  });
  return res.status(201).json(m);
});

router.get('/tasks/:id/chat/student/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const tId = normalizeId(req.params.id);
  const sId = toObjectIdString(req.query.studentId);
  const aId = toObjectIdString(req.user.id);

  const m = await Message.find({ 
    task: tId, student: sId,
    $or: [{ sender: aId, receiver: sId }, { sender: sId, receiver: aId }] 
  }).populate('sender receiver', 'name role').sort({ createdAt: 1 });
  return res.json(m);
});

router.post('/tasks/:id/chat/student/messages', verifyJWT, ensureAdmin, async (req, res) => {
  const tId = normalizeId(req.params.id);
  const { error, value } = adminMessageSchema.validate(req.body);
  if (error) return res.status(400).json({ message: 'Input error' });
  const sId = toObjectIdString(value.studentId);

  const m = await Message.create({ 
    task: tId, sender: req.user.id, receiver: sId, student: sId, 
    text: value.text, fileUrl: value.fileUrl, fileName: value.fileName 
  });
  return res.status(201).json(m);
});

module.exports = router;