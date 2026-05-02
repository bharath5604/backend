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

// backend/routes/task.js (or wherever your task routes are)

router.post('/:id/feedback', verifyJWT, async (req, res) => {
  try {
    // 1. Validate Input First
    const { error, value } = feedbackSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ message: 'Score (1-5) and feedback text are required.' });
    }

    // 2. Fetch the Task
    const task = await Task.findById(req.params.id);
    
    // 3. Security & Existence Checks
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.client.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied. Only the client can provide feedback.' });
    }

    // 4. Check if feedback already exists (Now that 'task' is defined)
    if ((task.rating && task.rating > 0) || task.feedback) {
      return res.status(400).json({ message: 'Feedback has already been provided for this task.' });
    }

    // 5. Fetch the Student
    const student = await User.findById(task.student);
    if (!student) {
      return res.status(404).json({ message: 'Student assigned to this task not found.' });
    }

    // 6. Update Task Data
    task.feedback = value.text || '';
    task.score = value.score;
    task.rating = value.score;
    await task.save();

    // 7. Update Student Aggregate Stats
    student.totalScore = (student.totalScore || 0) + value.score;
    student.totalScoreCount = (student.totalScoreCount || 0) + 1;

    // Handle Domain-specific scores
    const taskDomain = task.domain || 'General';
    if (!student.feedbackScores) student.feedbackScores = [];
    
    let domainEntry = student.feedbackScores.find(d => d.domain === taskDomain);
    if (domainEntry) {
      domainEntry.totalScore += value.score;
      domainEntry.count += 1;
    } else {
      student.feedbackScores.push({ 
        domain: taskDomain, 
        totalScore: value.score, 
        count: 1 
      });
    }

    // Add entry to Student's feedback history
    if (!student.feedbackEntries) student.feedbackEntries = [];
    
    // Fetch client name for the history entry
    const clientUser = await User.findById(req.user.id).select('name');
    
    student.feedbackEntries.push({
      taskId: task._id,
      taskTitle: task.title,
      clientId: req.user.id,
      clientName: clientUser?.name || 'Client',
      rating: value.score,
      comment: value.text || '',
      domain: taskDomain,
      createdAt: new Date()
    });

    // 8. Update Student's Global Average Rating
    if (student.totalScoreCount > 0) {
        student.averageScore = student.totalScore / student.totalScoreCount;
    }

    await student.save();

    // 9. Real-time Notification
    const io = req.app.get('socketio');
    if (io) {
      io.to(task.student.toString()).emit('feedback_update', { 
        message: 'New feedback received!',
        rating: value.score 
      });
    }

    return res.status(201).json({ 
      message: 'Feedback saved successfully',
      averageScore: student.averageScore 
    });

  } catch (err) {
    console.error('Feedback Submission Error:', err);
    return res.status(500).json({ 
      message: 'Internal server error while saving feedback',
      details: err.message 
    });
  }
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
      return res.status(403).json({ message: 'Payment for task activation is pending.' });
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

/**
 * POST /api/tasks/:id/approve
 * WORKFLOW: 
 * 1. Client marks work as approved.
 * 2. Task moves to 'awaiting_final_payment'.
 * 3. Payment Ledger moves to 'approved' (This enables the "Verify 80%" button for Admin).
 */
router.post(['/:id/approve', '/:id/approve-submission'], verifyJWT, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // 1. Fetch Task
    const task = await Task.findById(req.params.id).session(session);
    
    if (!task) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Task not found' });
    }

    // 2. Authorization Check (Only the client who owns the task can approve)
    if (task.client.toString() !== req.user.id) {
      await session.abortTransaction();
      return res.status(403).json({ message: 'Forbidden: You do not own this task' });
    }

    // 3. Validation Check (Must have a submission to approve)
    if (!task.submission) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'No student submission found to approve' });
    }

    // 4. Update Task Submission Metadata
    task.submission.approved = true;
    task.submission.clientApprovedAt = new Date();
    
    // 5. Update Task Workflow Status
    task.status = 'awaiting_final_payment'; 

    // 6. Update Payment Ledger
    // Find the ledger associated with this task
    const payment = await Payment.findOne({ task: task._id }).session(session);
    
    if (!payment) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Payment ledger not found for this task' });
    }

    /** 
     * CRITICAL: Moving status to 'approved'. 
     * This makes the "Verify 80%" button visible in the Admin's Financial Management page.
     */
    payment.status = 'approved'; 

    // 7. Save both documents atomically
    await task.save({ session });
    await payment.save({ session });

    await session.commitTransaction();

    // 8. Background Notification to Admin/Student (Optional but recommended)
    try {
        await sendNotification(task.student, {
            title: 'Work Approved!',
            body: `The client has approved your work for "${task.title}". Admin will verify the final payout shortly.`,
            data: { type: 'task_approved', taskId: task._id.toString() }
        });
    } catch (notifErr) {
        console.error('Notification failed after approval:', notifErr.message);
    }

    return res.json({ 
      message: 'Work approved successfully. Awaiting final payment verification from Admin.', 
      status: task.status,
      paymentStatus: payment.status
    });

  } catch (err) {
    // Rollback changes if anything goes wrong
    if (session.inTransaction()) {
        await session.abortTransaction();
    }
    console.error('CRITICAL APPROVAL ERROR:', err.message);
    
    return res.status(500).json({ 
      message: 'Internal Server Error during approval process', 
      error: err.message 
    });
  } finally {
    session.endSession();
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