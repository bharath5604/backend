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
// HELPERS & SECURITY
// =========================================================

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeId(value) {
  return clean(value);
}

const ensureAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin only' });
  }
  next();
};

// =========================================================
// 1. ANALYTICS & DASHBOARD (HIGHEST PRIORITY)
// =========================================================

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
      User.countDocuments({}), User.countDocuments({ role: 'client' }), User.countDocuments({ role: 'student' }),
      Task.countDocuments({}), Payment.countDocuments({}), Payment.countDocuments({ status: 'completed' })
    ]);
    const amounts = await Payment.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    return res.json({
      users: { total: uAll, clients: uCli, students: uStu },
      tasks: { total: tAll },
      payments: { totalCount: pAll, completedCount: pCom, completedAmount: amounts[0]?.total || 0 }
    });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// 2. TASK & CANDIDATE MANAGEMENT (FIXES 404)
// =========================================================

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

/**
 * GET /api/admin/tasks/:id/candidates
 * FIXED: Explicitly defined before the generic /tasks route
 */
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

router.get('/tasks', verifyJWT, ensureAdmin, async (req, res) => {
    const tasks = await Task.find({}).populate('client student requestedStudent').sort({ createdAt: -1 });
    return res.json(tasks);
});

// =========================================================
// 3. WITHDRAWALS & USERS
// =========================================================

router.get('/withdrawals', verifyJWT, ensureAdmin, async (req, res) => {
    const w = await Withdrawal.find({}).populate('student').sort({ createdAt: -1 });
    return res.json(w);
});

router.get('/users', verifyJWT, ensureAdmin, async (req, res) => {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    return res.json(users);
});

// =========================================================
// 4. ACTION ROUTES (LOWEST PRIORITY)
// =========================================================

router.post('/tasks/:id/assign', verifyJWT, ensureAdmin, async (req, res) => {
    const task = await Task.findById(req.params.id);
    task.requestedStudent = req.body.studentId;
    task.assignmentRequestStatus = 'request_sent';
    await task.save();
    return res.json({ message: 'Invitation Sent', task });
});

router.post('/tasks/:id/record-manual-payment', verifyJWT, ensureAdmin, async (req, res) => {
    const { type, note } = req.body;
    const task = await Task.findById(req.params.id);
    const payment = await Payment.findOne({ task: task._id });
    if (type === 'advance') {
        payment.advance.status = 'paid'; payment.status = 'partially_paid';
        task.status = 'assigned';
    } else {
        payment.final.status = 'paid'; payment.status = 'completed';
        task.status = 'completed';
        const student = await User.findById(task.student);
        student.wallet += task.budget; await student.save();
    }
    payment.adminNote = note; await payment.save(); await task.save();
    return res.json({ message: 'Recorded' });
});

router.get('/getPendingPayments', verifyJWT, ensureAdmin, async (req, res) => {
    const p = await Payment.find({ status: { $in: ['awaiting_advance', 'partially_paid', 'approved'] } })
      .populate('student task').sort({ createdAt: -1 });
    return res.json(p);
});

router.post('/releasePayment/:id', verifyJWT, ensureAdmin, async (req, res) => {
    const pay = await Payment.findById(req.params.id);
    pay.status = 'completed'; pay.releasedAt = new Date(); await pay.save();
    return res.json({ message: 'Released' });
});

// CHARTS & GROWTH
router.get('/getTimeSeriesStats', verifyJWT, ensureAdmin, async (req, res) => {
    const tasks = await Task.aggregate([{ $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } }, count: { $sum: 1 } } }]);
    return res.json({ tasks });
});

router.get('/stats/growth', verifyJWT, ensureAdmin, async (req, res) => {
    const metric = req.query.metric || 'tasks';
    let coll = metric === 'students' ? User : metric === 'payments' ? Payment : Task;
    const growth = await coll.aggregate([{ $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } }]);
    return res.json(growth);
});

// MESSAGING
router.get('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
    const t = await Task.findById(req.params.id);
    const m = await Message.find({ task: req.params.id, $or: [{ sender: req.user.id, receiver: t.client }, { sender: t.client, receiver: req.user.id }] }).populate('sender receiver', 'name role').sort({ createdAt: 1 });
    return res.json(m);
});

router.post('/tasks/:id/chat/client/messages', verifyJWT, ensureAdmin, async (req, res) => {
    const t = await Task.findById(req.params.id);
    const m = await Message.create({ task: req.params.id, sender: req.user.id, receiver: t.client, text: req.body.text });
    return res.status(201).json(m);
});

module.exports = router;