// backend/routes/tasks.js
const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const User = require('../models/User');
const Message = require('../models/Message');
const verifyJWT = require('../middleware/authMiddleware');
const taskController = require('../controllers/taskController'); // Core Logic
const Joi = require('joi');

// =========================================================
// JOI SCHEMAS (SYNCHRONIZED WITH UI CHANGES)
// =========================================================

const createTaskSchema = Joi.object({
  title: Joi.string().min(3).max(200).required(),
  description: Joi.string().min(10).max(5000).required(),
  
  // MODIFICATION: Budget is now optional during initial post.
  // This prevents 400 Errors when the Client leaves it blank.
  budget: Joi.number().min(0).allow(null, '').optional(), 
  
  deadline: Joi.date().required(),
  location: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  requiredSkills: Joi.array().items(Joi.string().max(100)).default([]),
  company: Joi.string().max(200).allow('', null),
  attachments: Joi.array().items(Joi.string().uri()).default([]),
  attachmentNames: Joi.array().items(Joi.string()).default([]),
  clientAgreedToTerms: Joi.boolean().valid(true).required(),
});

const guestTaskSchema = Joi.object({
  title: Joi.string().min(3).max(200).required(),
  description: Joi.string().min(10).max(5000).required(),
  guestName: Joi.string().required(),
  guestMobile: Joi.string().required(),
  guestEmail: Joi.string().email().allow('', null),
  
  // MODIFICATION: Budget optional for guest leads.
  budget: Joi.number().min(0).allow(null, '').optional(),
  
  deadline: Joi.date().required(),
  domain: Joi.string().allow('', null),
  requiredSkills: Joi.array().items(Joi.string()).default([]),
});

const feedbackSchema = Joi.object({
  feedback: Joi.string().max(2000).allow('', null), 
  text: Joi.string().max(2000).allow('', null),
  score: Joi.number().integer().min(1).max(5).required(),
});

// =========================================================
// 1. DATA RETRIEVAL (DASHBOARD & WORKSPACE)
// =========================================================

/**
 * Provides dynamic filters based on existing DB entries
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

/**
 * Returns tasks actively assigned to the logged-in student
 */
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
 * Returns task invitations (Pending Acceptance)
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
 * Aggregates tasks for the real-time chat inbox
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
 * Returns tasks posted by the logged-in client
 */
router.get('/mine', verifyJWT, async (req, res) => {
  try {
    const tasks = await Task.find({ client: req.user.id }).sort({ createdAt: -1 });
    res.json(tasks);
  } catch (err) { res.status(500).json({ message: 'Error loading tasks' }); }
});

// =========================================================
// 2. CREATION & SUBMISSION (ROUTED TO CONTROLLER)
// =========================================================

router.post('/create', verifyJWT, taskController.createTask);
router.post('/guest-create', taskController.createGuestTask);
router.post('/:id/submit', verifyJWT, taskController.submitWork);

// =========================================================
// 3. WORKFLOW ACTIONS (RELIANT ON CONTROLLER FOR SOCKETS)
// =========================================================

/**
 * Transitions task from Invite -> Active
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
    
    // Broadcast update to Admin and Client rooms
    const io = req.app.get('socketio');
    if (io) {
        io.to('admin_room').emit('task_update', { taskId: task._id });
        io.to(`${task._id}_client`).emit('task_update', { taskId: task._id });
    }

    res.json({ message: 'Task assigned and active', task });
  } catch (err) { res.status(500).json({ message: 'Acceptance failed' }); }
});

/**
 * Approves student deliverables
 */
router.post('/:id/approve', verifyJWT, taskController.approveWork);

/**
 * MODIFICATION: Client requests revision. 
 * Linked to Controller to ensure modificationNotes are saved and no limit is enforced.
 */
router.post('/:id/decline', verifyJWT, taskController.declineWork);

/**
 * Final Feedback and Rating
 */
router.post('/:id/feedback', verifyJWT, async (req, res, next) => {
  const { error } = feedbackSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });
  return taskController.rateStudent(req, res);
});

// =========================================================
// 4. GENERAL RETRIEVAL & DELETION
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
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (task.client.toString() !== req.user.id) return res.status(403).json({ message: 'Denied' });
    
    await Task.deleteOne({ _id: req.params.id });
    res.json({ message: 'Task deleted' });
  } catch (err) { res.status(500).json({ message: 'Deletion failed' }); }
});

module.exports = router;