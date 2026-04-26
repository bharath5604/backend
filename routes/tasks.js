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
  studentAgreedToTerms: Joi.boolean().valid(true).required()
});

const feedbackSchema = Joi.object({
  text: Joi.string().max(2000).allow('', null),
  score: Joi.number().integer().min(1).max(5).required(),
});

const submissionSchema = Joi.object({
  fileUrl: Joi.string().uri().max(2000).required(),
  notes: Joi.string().max(2000).allow('', null),
});

// =========================================================
// 1. HIGH-PRIORITY STATIC ROUTES (FIXES 404)
// =========================================================

router.get('/assigned', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ message: 'Forbidden' });
    // Include the new payment states so tasks don't disappear from student view while waiting for money
    const tasks = await Task.find({
      student: req.user.id,
      status: { $in: ['assigned', 'under_review', 'completed', 'declined', 'awaiting_advance', 'awaiting_final_payment'] },
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
    if (req.query.minBudget || req.query.maxBudget) {
      query.budget = {};
      if (req.query.minBudget) query.budget.$gte = Number(req.query.minBudget);
      if (req.query.maxBudget) query.budget.$lte = Number(req.query.maxBudget);
    }
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
    const query = { status: 'open' };
    if (req.query.location) query.location = cleanStr(req.query.location);
    if (req.query.domain) query.domain = cleanStr(req.query.domain);
    if (req.user.role === 'student') {
      const student = await User.findById(req.user.id).select('skills');
      if (student?.skills?.length > 0) query.requiredSkills = { $in: student.skills };
    }
    const tasks = await Task.find(query).populate('client', 'name company').sort({ createdAt: -1 });
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

// =========================================================
// 3. PARAMETERIZED SUB-PATHS (MEDIUM PRIORITY)
// =========================================================

/**
 * POST /api/tasks/:id/feedback
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
 * WORKFLOW GATE 1: Moves task to 'awaiting_advance'. 
 * This allows Admin to manually "Mark as Paid" or Client to use Razorpay.
 */
router.post('/:id/accept-request', verifyJWT, async (req, res) => {
  try {
    const { error } = acceptRequestSchema.validate(req.body);
    if (error) return res.status(400).json({ message: 'Accept T&C first' });

    const task = await Task.findById(req.params.id);
    if (!task || task.requestedStudent?.toString() !== req.user.id) {
      return res.status(404).json({ message: 'Invitation not found' });
    }

    // Initialize Payment ledger for the Admin to see in "Verifications"
    await Payment.create({
      task: task._id,
      client: task.client,
      student: req.user.id,
      totalBudget: task.budget,
      netToStudent: task.budget, 
      advance: { amount: task.budget * 0.20, status: 'pending' },
      final: { amount: task.budget * 0.80, status: 'pending' },
      status: 'awaiting_advance' // THE GATE: Admin can now override this manually
    });

    task.student = req.user.id;
    task.studentAgreedToTerms = true;
    task.status = 'awaiting_advance'; 
    task.assignedAt = new Date();
    task.requestedStudent = null;
    task.assignmentRequestStatus = null;

    await task.save();

    await sendNotification(task.client, {
      title: 'Invitation Accepted!',
      body: `Student accepted your task "${task.title}". Waiting for 20% advance.`,
      data: { type: 'payment_needed', taskId: task._id.toString() }
    });

    return res.json({ message: 'Accepted. Awaiting payment.', task });
  } catch (err) { 
    return res.status(500).json({ message: 'Failed to accept' }); 
  }
});

/**
 * POST /api/tasks/:id/submit
 * Logic: Student can only submit if status is 'assigned' (meaning 20% was paid)
 */
router.post('/:id/submit', verifyJWT, async (req, res) => {
  try {
    const { value } = submissionSchema.validate(req.body);
    const task = await Task.findById(req.params.id);
    
    if (task.status === 'awaiting_advance') {
      return res.status(403).json({ message: 'Cannot submit work until advance payment is verified' });
    }

    task.submission = { student: req.user.id, fileUrl: value.fileUrl, notes: value.notes || '', submittedAt: new Date() };
    task.status = 'under_review';
    await task.save();

    return res.json({ message: 'Submitted', task });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

/**
 * POST /api/tasks/:id/approve
 * WORKFLOW GATE 2: Moves task to 'awaiting_final_payment'.
 * This allows Admin to manually "Mark as Paid" for the 80% balance.
 */
router.post(['/:id/approve', '/:id/approve-submission'], verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task || task.client.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
    
    task.submission.approved = true;
    task.status = 'awaiting_final_payment'; // THE GATE: Admin can now override this manually
    await task.save();

    // Mark Phase 2 as ready in the payment ledger
    const payment = await Payment.findOne({ task: task._id });
    if (payment) {
        payment.status = 'partially_paid'; // Meaning Phase 1 is done, waiting for Final
        await payment.save();
    }

    return res.json({ message: 'Work approved. Awaiting final 80% payment.', task });
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
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const match = { role: 'student', isApproved: true };
    if (task.requiredSkills?.length > 0) match.skills = { $in: task.requiredSkills };
    else if (task.domain) match.domain = task.domain;

    const students = await User.aggregate([
      { $match: match },
      { $addFields: { averageScore: { $cond: [{ $gt: ['$totalScoreCount', 0] }, { $divide: ['$totalScore', '$totalScoreCount'] }, 0] } } },
      { $sort: { averageScore: -1, tasksCompleted: -1 } },
      { $limit: 50 },
      { $project: { name: 1, email: 1, skills: 1, tasksCompleted: 1, averageScore: 1, wallet: 1, domain: 1, totalScoreCount: 1 } }
    ]);
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