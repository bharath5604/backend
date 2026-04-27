// backend/routes/tasks.js
const express = require('express');
const router = express.Router();

const Task = require('../models/Task');
const User = require('../models/User');
const Payment = require('../models/Payment');
const verifyJWT = require('../middleware/authMiddleware');
const Joi = require('joi');
const { sendNotification } = require('../utils/fcm');

// =========================================================
// HELPERS (RESTORED 100%)
// =========================================================

function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// =========================================================
// JOI SCHEMAS (RESTORED & EXPANDED)
// =========================================================

const createTaskSchema = Joi.object({
  title: Joi.string().min(3).max(200).required(),
  description: Joi.string().min(10).max(2000).required(),
  budget: Joi.number().positive().max(1_000_000).required(),
  deadline: Joi.date().required(),
  location: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  requiredSkills: Joi.array().items(Joi.string().max(100)).default([]),
  company: Joi.string().max(200).allow('', null),
  attachments: Joi.array().items(Joi.string().uri().max(2000)).default([]),
  attachmentNames: Joi.array().items(Joi.string().max(255)).default([]),
  clientAgreedToTerms: Joi.boolean().valid(true).required()
});

const acceptRequestSchema = Joi.object({
  studentAgreedToTerms: Joi.boolean().valid(true).optional(),
  acceptedTerms: Joi.boolean().valid(true).optional()
}).or('studentAgreedToTerms', 'acceptedTerms');

const feedbackSchema = Joi.object({
  text: Joi.string().max(2000).allow('', null),
  score: Joi.number().integer().min(1).max(5).required(),
});

const submissionSchema = Joi.object({
  fileUrl: Joi.string().uri().max(2000).required(),
  notes: Joi.string().max(2000).allow('', null),
});

// =========================================================
// 1. HIGH-PRIORITY STATIC ROUTES (FIXES 404 ERRORS)
// =========================================================

router.get('/assigned', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ message: 'Forbidden' });
    const tasks = await Task.find({
      student: req.user.id,
      status: { $in: ['assigned', 'under_review', 'completed', 'declined', 'awaiting_final_payment', 'awaiting_advance'] },
    }).populate('client', 'name company location').sort({ createdAt: -1 }).lean();
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Server error' }); }
});

router.get('/requests', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ message: 'Forbidden' });
    const requests = await Task.find({ 
      requestedStudent: req.user.id, 
      assignmentRequestStatus: 'request_sent' 
    }).populate('client', 'name company location');
    return res.json(requests);
  } catch (err) { return res.status(500).json({ message: 'Server error' }); }
});

router.get('/mine', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') return res.status(403).json({ message: 'Forbidden' });
    const tasks = await Task.find({ client: req.user.id }).populate('client', 'name company').sort({ createdAt: -1 }).lean();
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Server error' }); }
});

router.get('/recommended', verifyJWT, async (req, res) => {
  try {
    const student = await User.findById(req.user.id).select('skills');
    const tasks = await Task.find({ status: 'open', requiredSkills: { $in: student.skills || [] } })
      .sort({ createdAt: -1 }).limit(5).populate('client', 'name company');
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/search', verifyJWT, async (req, res) => {
  try {
    const query = { status: 'open' };
    if (req.query.domain) query.domain = cleanStr(req.query.domain);
    const tasks = await Task.find(query).populate('client', 'name company');
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Error searching' }); }
});

// =========================================================
// 2. CREATION & GENERAL FETCH
// =========================================================

router.post('/create', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') return res.status(403).json({ message: 'Only clients' });
    const { error, value } = createTaskSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ message: 'Validation error', details: error.details.map((d) => d.message) });
    
    const client = await User.findById(req.user.id);
    const task = await Task.create({ 
      ...value, 
      client: req.user.id, 
      company: value.company || client.company || '', 
      status: 'open' 
    });
    return res.json(task);
  } catch (err) { return res.status(400).json({ message: 'Creation failed' }); }
});

router.get('/', verifyJWT, async (req, res) => {
  try {
    const tasks = await Task.find({ status: 'open' }).populate('client', 'name company').sort({ createdAt: -1 });
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// 3. PARAMETERIZED SUB-PATHS (MEDIUM PRIORITY)
// =========================================================

/**
 * POST /api/tasks/:id/feedback
 * RESTORED: Updates global totals, domain-wise aggregates, and entry history.
 */
router.post('/:id/feedback', verifyJWT, async (req, res) => {
  try {
    const { error, value } = feedbackSchema.validate(req.body);
    if (error) return res.status(400).json({ message: 'Score is required' });

    const task = await Task.findById(req.params.id);
    if (!task || task.client.toString() !== req.user.id) return res.status(403).json({ message: 'Access denied' });

    const student = await User.findById(task.student);
    if (!student) return res.status(404).json({ message: 'Student not found' });

    task.feedback = value.text || '';
    task.score = value.score;
    task.rating = value.score;
    await task.save();

    student.totalScore = (student.totalScore || 0) + value.score;
    student.totalScoreCount = (student.totalScoreCount || 0) + 1;

    const taskDomain = task.domain || 'General';
    if (!student.feedbackScores) student.feedbackScores = [];
    let domainEntry = student.feedbackScores.find(d => d.domain === taskDomain);
    if (domainEntry) {
      domainEntry.totalScore += value.score;
      domainEntry.count += 1;
    } else {
      student.feedbackScores.push({ domain: taskDomain, totalScore: value.score, count: 1 });
    }

    if (!student.feedbackEntries) student.feedbackEntries = [];
    const client = await User.findById(req.user.id).select('name');
    student.feedbackEntries.push({
      taskId: task._id,
      taskTitle: task.title,
      clientId: req.user.id,
      clientName: client?.name || 'Client',
      rating: value.score,
      comment: value.text || '',
      domain: taskDomain,
      createdAt: new Date()
    });

    await student.save();
    return res.status(201).json({ message: 'Feedback saved' });
  } catch (err) { return res.status(500).json({ message: 'Error saving feedback' }); }
});

/**
 * POST /api/tasks/:id/accept-request
 * FIXED: Resolves 500 Error by properly initializing Payment record without 'bid'
 */
router.post('/:id/accept-request', verifyJWT, async (req, res) => {
  try {
    const { error } = acceptRequestSchema.validate(req.body);
    if (error) return res.status(400).json({ message: 'Accept T&C first' });

    const task = await Task.findById(req.params.id);
    if (!task || task.requestedStudent?.toString() !== req.user.id) return res.status(404).json({ message: 'Invitation not found' });

    // Initialize Payment Ledger (The stop point for Admin/Client)
    await Payment.create({
      task: task._id,
      client: task.client,
      student: req.user.id,
      totalBudget: task.budget,
      netToStudent: task.budget,
      advance: { amount: task.budget * 0.20, status: 'pending' },
      final: { amount: task.budget * 0.80, status: 'pending' },
      status: 'awaiting_advance'
    });

    task.student = req.user.id;
    task.studentAgreedToTerms = true;
    task.status = 'awaiting_advance'; 
    task.assignedAt = new Date();
    task.requestedStudent = null;
    task.assignmentRequestStatus = null;

    await task.save();
    return res.json({ message: 'Accepted. Awaiting payment.', task });
  } catch (err) { 
    console.error('Accept Request Error:', err.message);
    return res.status(500).json({ message: 'Internal Server Error' }); 
  }
});

/**
 * POST /api/tasks/:id/submit
 * Logic: Prevents submission if Phase 1 (20%) is not yet verified
 */
router.post('/:id/submit', verifyJWT, async (req, res) => {
  try {
    const { value } = submissionSchema.validate(req.body);
    const task = await Task.findById(req.params.id);
    if (!task || task.student?.toString() !== req.user.id) return res.status(403).json({ message: 'Denied' });

    if (task.status === 'awaiting_advance') {
      return res.status(403).json({ message: 'Payment for project activation is pending.' });
    }

    task.submission = { student: req.user.id, fileUrl: value.fileUrl, notes: value.notes || '', submittedAt: new Date() };
    task.status = 'under_review';
    await task.save();

    await sendNotification(task.client, {
      title: 'New submission',
      body: `Review work for "${task.title}"`,
      data: { type: 'task_submitted', taskId: task._id.toString() }
    });

    return res.json({ message: 'Submitted', task });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

/**
 * POST /api/tasks/:id/approve
 * WORKFLOW: Moves task to Phase 2 (Awaiting 80%)
 */
router.post(['/:id/approve', '/:id/approve-submission'], verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task || task.client.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
    if (!task.submission) return res.status(400).json({ message: 'No submission found' });

    task.submission.approved = true;
    task.status = 'awaiting_final_payment'; 
    await task.save();

    const payment = await Payment.findOne({ task: task._id });
    if (payment) { payment.status = 'partially_paid'; await payment.save(); }

    return res.json({ message: 'Work approved. Please pay the remaining 80%.', task });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.post(['/:id/decline', '/:id/request-revision'], verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task || task.client.toString() !== req.user.id) return res.status(403).json({ message: 'Denied' });
    task.attemptCount = (task.attemptCount || 0) + 1;
    task.submission = null;
    task.status = task.attemptCount >= task.maxAttempts ? 'declined' : 'assigned';
    await task.save();
    return res.json({ message: 'Revision requested', task });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// 4. GENERIC PARAMETERIZED ROUTES (LOWEST PRIORITY)
// =========================================================

router.get('/:id/candidates', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });
    const task = await Task.findById(req.params.id);
    const students = await User.find({ role: 'student', isApproved: true, skills: { $in: task.requiredSkills || [] } });
    return res.json(students);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/:id', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id).populate('client student');
    if (!task) return res.status(404).json({ message: 'Not found' });
    return res.json(task);
  } catch (err) { return res.status(404).json({ message: 'Not found' }); }
});

router.delete('/:id', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (task.client.toString() !== req.user.id) return res.status(403).json({ message: 'Denied' });
    await Task.deleteOne({ _id: req.params.id });
    return res.json({ message: 'Deleted' });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

module.exports = router;