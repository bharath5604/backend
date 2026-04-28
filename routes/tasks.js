// backend/routes/tasks.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Task = require('../models/Task');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Message = require('../models/Message'); // Added for chat-list logic
const verifyJWT = require('../middleware/authMiddleware');
const Joi = require('joi');
const { sendNotification } = require('../utils/fcm');

// =========================================================
// HELPERS
// =========================================================

function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// =========================================================
// JOI SCHEMAS
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
// 1. HIGH-PRIORITY STATIC ROUTES
// =========================================================

/**
 * FIXED: /assigned
 * Now includes tasks where the user is either the final student OR the requested student.
 * This ensures they appear in the "Workspace" and "Chat" lists during vetting.
 */
router.get('/assigned', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ message: 'Forbidden' });
    
    const tasks = await Task.find({
      $or: [
        { student: req.user.id },
        { requestedStudent: req.user.id }
      ],
      status: { $in: ['request_sent', 'assigned', 'under_review', 'completed', 'declined', 'awaiting_final_payment', 'awaiting_advance'] },
    }).populate('client', 'name company location').sort({ createdAt: -1 }).lean();
    
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Server error' }); }
});

/**
 * NEW: /chat-tasks
 * Specifically for the student's chat inbox. It fetches tasks where messages exist
 * between the admin and the student, even if the task is still "Open".
 */
router.get('/chat-tasks', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Find all tasks where this student has participated in a message
    const taskIdsFromMessages = await Message.distinct('task', {
      $or: [{ sender: userId }, { receiver: userId }]
    });

    // 2. Find tasks where they are assigned, requested, OR have existing messages
    const tasks = await Task.find({
      $or: [
        { student: userId },
        { requestedStudent: userId },
        { _id: { $in: taskIdsFromMessages } }
      ]
    }).populate('client', 'name company').sort({ updatedAt: -1 });

    return res.json(tasks);
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching chat list' });
  }
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
// 3. PARAMETERIZED SUB-PATHS
// =========================================================

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

router.post('/:id/accept-request', verifyJWT, async (req, res) => {
  try {
    const { error } = acceptRequestSchema.validate(req.body);
    if (error) return res.status(400).json({ message: 'Accept T&C first' });

    const task = await Task.findById(req.params.id);
    if (!task || task.requestedStudent?.toString() !== req.user.id) return res.status(404).json({ message: 'Invitation not found' });

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
    return res.status(500).json({ message: 'Internal Server Error' }); 
  }
});

router.post('/:id/submit', verifyJWT, async (req, res) => {
  try {
    const { error, value } = submissionSchema.validate(req.body);
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
 * WORKFLOW: Moves task to 'awaiting_final_payment' AND Payment to 'approved'
 */
// backend/routes/tasks.js

router.post(['/:id/approve', '/:id/approve-submission'], verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task || task.client.toString() !== req.user.id) {
        return res.status(403).json({ message: 'Forbidden' });
    }
    if (!task.submission) {
        return res.status(400).json({ message: 'No submission found' });
    }

    // 1. Update Task
    task.submission.approved = true;
    task.submission.clientApprovedAt = new Date();
    task.status = 'awaiting_final_payment'; 

    // 2. Update Payment
    const payment = await Payment.findOne({ task: task._id });
    if (!payment) {
        return res.status(404).json({ message: 'Payment record not found' });
    }

    payment.status = 'approved'; // This triggers the "Verify 80%" button in Flutter

    // 3. Atomic Save (Both must succeed)
    await task.save();
    await payment.save();

    return res.json({ 
        message: 'Work approved. Awaiting final payment verification.', 
        status: task.status 
    });
    
  } catch (err) {
    console.error('APPROVAL ERROR:', err.message);
    return res.status(500).json({ 
        message: 'Internal Server Error during approval', 
        error: err.message 
    });
  }
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
// 4. GENERIC PARAMETERIZED ROUTES
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