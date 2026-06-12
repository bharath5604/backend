// backend/routes/tasks.js
const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const User = require('../models/User');
const Message = require('../models/Message');
const verifyJWT = require('../middleware/authMiddleware');
const taskController = require('../controllers/taskController');
const Joi = require('joi');
const { sendNotification } = require('../utils/fcm');

// =========================================================
// JOI SCHEMAS
// =========================================================

const createTaskSchema = Joi.object({
  title: Joi.string().min(3).max(200).required(),
  description: Joi.string().min(10).max(5000).required(),
  budget: Joi.number().min(0).allow(null, ''), // Requirement: Optional
  deadline: Joi.date().required(),
  location: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  requiredSkills: Joi.array().items(Joi.string().max(100)).default([]),
  company: Joi.string().max(200).allow('', null),
  attachments: Joi.array().items(Joi.string().uri()).default([]),
  attachmentNames: Joi.array().items(Joi.string()).default([]),
  clientAgreedToTerms: Joi.boolean().valid(true).required() ,
});

const guestTaskSchema = Joi.object({
  title: Joi.string().min(3).max(200).required(),
  description: Joi.string().min(10).max(5000).required(),
  guestName: Joi.string().required(),
  guestMobile: Joi.string().required(),
  guestEmail: Joi.string().email().allow('', null),
  budget: Joi.number().min(0).allow(null, ''),
  deadline: Joi.date().required(),
  domain: Joi.string().allow('', null),
  requiredSkills: Joi.array().items(Joi.string()).default([]),
});

const submissionSchema = Joi.object({
  fileUrl: Joi.string().uri().required(),
  notes: Joi.string().max(2000).allow('', null),
});

const feedbackSchema = Joi.object({
  feedback: Joi.string().max(2000).allow('', null), 
  text: Joi.string().max(2000).allow('', null),
  score: Joi.number().integer().min(1).max(5).required(),
});

// =========================================================
// 1. STATIC & HIGH-PRIORITY ROUTES
// =========================================================

/**
 * GET /api/tasks/assigned
 * Returns tasks currently active or under review for the student
 */
router.get('/filters', verifyJWT, async (req, res) => {
    try {
        const [locations, domains] = await Promise.all([
            Task.distinct("location"),
            Task.distinct("domain")
        ]);
        res.json({
            locations: locations.filter(Boolean).sort(),
            domains: domains.filter(Boolean).sort()
        });
    } catch (err) {
        res.status(500).json({ message: "Failed to load project filters" });
    }
});

router.get('/assigned', verifyJWT, async (req, res) => {
  try {
    const tasks = await Task.find({
      student: req.user.id,
      status: { $in: ['assigned', 'under_review', 'completed', 'declined'] },
    }).populate('client', 'name company location').sort({ updatedAt: -1 });
    res.json(tasks);
  } catch (err) { res.status(500).json({ message: 'Error loading workspace' }); }
});

/**
 * GET /api/tasks/requests
 * Returns formal invitations sent by Admin
 */
router.get('/requests', verifyJWT, async (req, res) => {
  try {
    const requests = await Task.find({ 
      requestedStudent: req.user.id, 
      assignmentRequestStatus: 'request_sent' 
    }).populate('client', 'name company location');
    res.json(requests);
  } catch (err) { res.status(500).json({ message: 'Error loading invitations' }); }
});

/**
 * GET /api/tasks/chat-tasks
 * Used to build the student's inbox
 */
router.get('/chat-tasks', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const taskIds = await Message.distinct('task', { $or: [{ sender: userId }, { receiver: userId }] });
    const tasks = await Task.find({
      $or: [{ student: userId }, { requestedStudent: userId }, { _id: { $in: taskIds } }]
    }).populate('client', 'name company').sort({ updatedAt: -1 });
    res.json(tasks);
  } catch (err) { res.status(500).json({ message: 'Error loading chat list' }); }
});

/**
 * GET /api/tasks/mine
 * Returns tasks created by the logged-in client
 */
router.get('/mine', verifyJWT, async (req, res) => {
  try {
    const tasks = await Task.find({ client: req.user.id }).sort({ createdAt: -1 });
    res.json(tasks);
  } catch (err) { res.status(500).json({ message: 'Error loading tasks' }); }
});

// =========================================================
// 2. CREATION ROUTES
// =========================================================

/**
 * Requirement: Create Task (Registered User)
 */
router.post('/create', verifyJWT, async (req, res) => {
  try {
    const { error, value } = createTaskSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const task = await Task.create({
      ...value,
      client: req.user.id,
      isGuestTask: false,
      status: 'open'
    });
    res.status(201).json(task);
  } catch (err) { res.status(500).json({ message: 'Creation failed' }); }
});

/**
 * Requirement: Emergency Task (Guest Flow)
 */
router.post('/guest-create', async (req, res) => {
  try {
    const { error, value } = guestTaskSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const task = await Task.create({
      title: value.title,
      description: value.description,
      deadline: value.deadline,
      budget: value.budget,
      domain: value.domain,
      requiredSkills: value.requiredSkills,
      isGuestTask: true,
      guestInfo: {
        name: value.guestName,
        mobile: value.guestMobile,
        email: value.guestEmail
      },
      status: 'open'
    });
    res.status(201).json(task);
  } catch (err) { res.status(500).json({ message: 'Emergency submission failed' }); }
});

// =========================================================
// 3. WORKFLOW ACTIONS
// =========================================================

/**
 * FIXED: Accept Request
 * Logic: Transitions task to 'assigned' directly. No Payment record created.
 */
router.post('/:id/accept-request', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task || task.requestedStudent?.toString() !== req.user.id) {
      return res.status(404).json({ message: 'Invite not found' });
    }

    task.student = req.user.id;
    task.studentAgreedToTerms = true;
    task.status = 'assigned'; 
    task.assignedAt = new Date();
    task.requestedStudent = null;
    task.assignmentRequestStatus = null;

    await task.save();
    res.json({ message: 'Task assigned and active', task });
  } catch (err) { res.status(500).json({ message: 'Acceptance failed' }); }
});

/**
 * Requirement: Student Submit Work
 * Logic: Set visibility to false so Admin can vet it first
 */
router.post('/:id/submit', verifyJWT, async (req, res) => {
  try {
    const { error, value } = submissionSchema.validate(req.body);
    if (error) return res.status(400).json({ message: "File required" });

    const task = await Task.findById(req.params.id);
    if (!task || task.student?.toString() !== req.user.id) return res.status(403).json({ message: 'Unauthorized' });

    task.submission = {
      student: req.user.id,
      fileUrl: value.fileUrl,
      notes: value.notes,
      submittedAt: new Date()
    };
    task.status = 'under_review';
    task.clientCanViewSubmission = false; // Hidden until Admin vetting

    await task.save();
    res.json({ message: 'Work submitted for Admin review', task });
  } catch (err) { res.status(500).json({ message: 'Submission failed' }); }
});

/**
 * Requirement: Client Approve Work
 * Logic: Status moves to completed. This triggers QR visibility in UI.
 */
router.post('/:id/approve', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task || task.client?.toString() !== req.user.id) return res.status(403).json({ message: 'Unauthorized' });

    task.submission.approved = true;
    task.submission.clientApprovedAt = new Date();
    task.status = 'completed';

    await task.save();

    // Reputation update
    await User.findByIdAndUpdate(task.student, { $inc: { tasksCompleted: 1 } });

    res.json({ message: 'Deliverables approved. Scan QR to pay Admin.', task });
  } catch (err) { res.status(500).json({ message: 'Approval failed' }); }
});

/**
 * Requirement: Request Revision
 */
router.post('/:id/decline', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task || task.client?.toString() !== req.user.id) return res.status(403).json({ message: 'Unauthorized' });

    task.attemptCount += 1;
    task.submission = null;
    task.clientCanViewSubmission = false;
    task.status = task.attemptCount >= task.maxAttempts ? 'declined' : 'assigned';

    await task.save();
    res.json({ message: 'Revision requested', task });
  } catch (err) { res.status(500).json({ message: 'Update failed' }); }
});

/**
 * Requirement: Provide Feedback/Rating
 */
// router.post('/:id/feedback', verifyJWT, async (req, res) => {
//   try {
//     const { error, value } = feedbackSchema.validate(req.body);
//     if (error) return res.status(400).json({ message: "Invalid feedback data" });

//     const task = await Task.findById(req.params.id);
//     if (!task || task.client?.toString() !== req.user.id) return res.status(403).json({ message: 'Denied' });

//     task.feedback = value.text;
//     task.score = value.score;
//     task.rating = value.score;
//     await task.save();

//     // Aggregates for student
//     const student = await User.findById(task.student);
//     student.totalScore += value.score;
//     student.totalScoreCount += 1;
//     await student.save();

//     res.json({ message: 'Feedback saved' });
//   } catch (err) { res.status(500).json({ message: 'Failed to save feedback' }); }
// });
router.post('/:id/feedback', verifyJWT, async (req, res, next) => {
  const { error } = feedbackSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });
  return taskController.rateStudent(req, res);
});

// =========================================================
// 4. GENERAL RETRIEVAL
// =========================================================

router.get('/:id', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id).populate('client student');
    if (!task) return res.status(404).json({ message: 'Task not found' });
    res.json(task);
  } catch (err) { res.status(404).json({ message: 'Not found' }); }
});

router.delete('/:id', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (task.client.toString() !== req.user.id) return res.status(403).json({ message: 'Denied' });
    await Task.deleteOne({ _id: req.params.id });
    res.json({ message: 'Task deleted' });
  } catch (err) { res.status(500).json({ message: 'Deletion failed' }); }
});

module.exports = router;