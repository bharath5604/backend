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
// HELPERS (RESTORED)
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

const rateSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
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
// 1. SPECIFIC ROUTES (MUST BE AT THE TOP TO FIX 404)
// =========================================================

/**
 * GET /api/tasks/assigned
 * FIXED: Moved to top so Express finds it before /:id
 */
router.get('/assigned', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can view assigned tasks' });
    }

    const tasks = await Task.find({
      student: req.user.id,
      status: { $in: ['assigned', 'under_review', 'completed', 'declined'] },
    })
      .populate('client', 'name company location')
      .sort({ createdAt: -1 })
      .lean();

    return res.json(tasks);
  } catch (err) {
    console.error('Error in GET /assigned:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

/**
 * GET /api/tasks/requests
 * NEW: Students see tasks where Admin has sent an invitation ("Tick")
 */
router.get('/requests', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ message: 'Only students' });
    
    const requests = await Task.find({
      requestedStudent: req.user.id,
      assignmentRequestStatus: 'request_sent'
    }).populate('client', 'name company location');

    return res.json(requests);
  } catch (err) { 
    console.error('Error in GET /requests:', err);
    return res.status(500).json({ message: 'Server error' }); 
  }
});

/**
 * GET /api/tasks/mine
 * RESTORED: Client's personal task list
 */
router.get('/mine', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') return res.status(403).json({ message: 'Only clients' });
    const tasks = await Task.find({ client: req.user.id })
      .populate('client', 'name company')
      .sort({ createdAt: -1 })
      .lean();
    return res.json(tasks);
  } catch (err) { 
    return res.status(500).json({ message: 'Server error' }); 
  }
});

router.get('/recommended', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.json([]);
    const student = await User.findById(req.user.id).select('skills');
    if (!student?.skills?.length) return res.json([]);

    const tasks = await Task.find({ status: 'open', requiredSkills: { $in: student.skills } })
      .sort({ createdAt: -1 }).limit(5).populate('client', 'name company');
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/search', verifyJWT, async (req, res) => {
  try {
    const query = { status: 'open' };
    if (req.query.domain) query.domain = req.query.domain;
    const tasks = await Task.find(query).populate('client', 'name company');
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Error searching' }); }
});

// =========================================================
// 2. CREATION & GENERAL FETCH
// =========================================================

/**
 * POST /api/tasks/create
 * MODIFIED: Enforces Client Terms & Conditions
 */
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
      status: 'open',
    });
    return res.json(task);
  } catch (err) { 
    console.error('Task creation failed:', err);
    return res.status(400).json({ message: 'Creation failed' }); 
  }
});

router.get('/', verifyJWT, async (req, res) => {
  try {
    const query = { status: 'open' };
    const tasks = await Task.find(query).populate('client', 'name company').sort({ createdAt: -1 });
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});
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
    await student.save();

    return res.status(201).json({ message: 'Feedback saved' });
  } catch (err) { return res.status(500).json({ message: 'Error saving feedback' }); }
});
// =========================================================
// 3. PARAMETERIZED ROUTES (MUST BE AT THE BOTTOM)
// =========================================================

/**
 * POST /api/tasks/:id/accept-request
 * Student Accepts Admin Tick invitation (Requires T&C confirmation)
 */
router.post('/:id/accept-request', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ message: 'Only students' });
    
    const { error } = acceptRequestSchema.validate(req.body);
    if (error) return res.status(400).json({ message: 'Accept Terms first' });

    const task = await Task.findById(req.params.id);
    if (!task || task.requestedStudent?.toString() !== req.user.id) {
      return res.status(404).json({ message: 'Invitation not found' });
    }

    // Finalize Assignment
    task.student = req.user.id;
    task.studentAgreedToTerms = true;
    task.status = 'assigned';
    task.assignedAt = new Date();
    task.requestedStudent = null;
    task.assignmentRequestStatus = null;

    await task.save();
    return res.json({ message: 'Task accepted successfully', task });
  } catch (err) { 
    console.error('Accept Request error:', err);
    return res.status(500).json({ message: 'Failed' }); 
  }
});

router.post('/:id/submit', verifyJWT, async (req, res) => {
  try {
    const { error, value } = submissionSchema.validate(req.body);
    if (error) return res.status(400).json({ message: 'Invalid data' });

    const task = await Task.findById(req.params.id);
    if (!task || task.student?.toString() !== req.user.id) return res.status(403).json({ message: 'Access denied' });

    task.submission = { student: req.user.id, fileUrl: value.fileUrl, notes: value.notes || '', submittedAt: new Date() };
    task.status = 'under_review';
    await task.save();
    return res.json({ message: 'Submitted', task });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

/**
 * POST /api/tasks/:id/approve
 * MODIFIED: Permission granted to CLIENT as per workflow
 */
router.post('/:id/approve', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    // Ensure only the task owner (Client) can approve
    if (req.user.id !== task.client.toString()) {
      return res.status(403).json({ message: 'Only the client can approve this work' });
    }

    if (!task.submission) return res.status(400).json({ message: 'No submission found' });

    task.submission.approved = true;
    task.status = 'completed';
    await task.save();

    // Move payment status to 'approved' for Admin release
    const payment = await Payment.findOne({ task: task._id, student: task.student });
    if (payment) { 
      payment.status = 'approved'; 
      await payment.save(); 
    }

    return res.json({ message: 'Work Approved', task });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

/**
 * POST /api/tasks/:id/decline
 * MODIFIED: Permission granted to CLIENT for revision requests
 */
router.post('/:id/decline', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task || req.user.id !== task.client.toString()) return res.status(403).json({ message: 'Denied' });

    task.attemptCount = (task.attemptCount || 0) + 1;
    task.submission = null;
    task.status = task.attemptCount >= task.maxAttempts ? 'declined' : 'assigned';
    await task.save();

    return res.json({ message: 'Revision Requested', task });
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
});

router.get('/:id/candidates', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });
    const task = await Task.findById(req.params.id);
    const students = await User.find({ role: 'student', isApproved: true, skills: { $in: task.requiredSkills || [] } });
    return res.json(students);
  } catch (err) { return res.status(500).json({ message: 'Error' }); }
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