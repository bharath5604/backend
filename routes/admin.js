// backend/routes/admin.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Joi = require('joi');

const User = require('../models/User');
const Task = require('../models/Task');
const Message = require('../models/Message');

const verifyJWT = require('../middleware/authMiddleware');
const { sendNotification } = require('../utils/fcm');

// =========================================================
// HELPERS
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
// JOI SCHEMAS
// =========================================================

const approveUserSchema = Joi.object({
  isApproved: Joi.boolean().required(),
});

const visibilitySchema = Joi.object({
  canView: Joi.boolean().required(),
});

const adminTaskFilterSchema = Joi.object({
  company: Joi.string().allow('', null),
  location: Joi.string().allow('', null),
  domain: Joi.string().allow('', null),
  status: Joi.string()
    .valid('open', 'assigned', 'under_review', 'completed', 'declined')
    .allow('', null),
});

const assignStudentSchema = Joi.object({
  studentId: Joi.string().required(),
});

// =========================================================
// 1. DASHBOARD ANALYTICS (CLEANED OF PAYMENTS)
// =========================================================

router.get('/getTopStudents', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    // Requirement: Sorted based on number of tasks done
    const top = await User.find({ role: 'student' })
      .select('name email location tasksCompleted averageScore')
      .sort({ tasksCompleted: -1 })
      .limit(10);
    return res.json(top);
  } catch (err) { return res.status(500).json({ message: 'Error fetching top students' }); }
});

router.get('/getTaskStats', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const stats = await Task.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    return res.json({ byStatus: stats });
  } catch (err) { return res.status(500).json({ message: 'Error fetching stats' }); }
});

router.get('/stats/overview', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const [uAll, uCli, uStu, tAll, tCom, tOpen] = await Promise.all([
      User.countDocuments({}), 
      User.countDocuments({ role: 'client' }),
      User.countDocuments({ role: 'student' }), 
      Task.countDocuments({}),
      Task.countDocuments({ status: 'completed' }),
      Task.countDocuments({ status: 'open' })
    ]);
    
    return res.json({
      users: { total: uAll, clients: uCli, students: uStu },
      tasks: { total: tAll, completed: tCom, open: tOpen }
    });
  } catch (err) { return res.status(500).json({ message: 'Error loading overview' }); }
});

// =========================================================
// 2. RESOURCE LISTS
// =========================================================

router.get('/users', verifyJWT, ensureAdmin, async (req, res) => {
  const { role, location, domain } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (location) filter.location = new RegExp(location, 'i');
  if (domain) filter.domain = new RegExp(domain, 'i');

  const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
  return res.json(users);
});

router.get('/tasks', verifyJWT, ensureAdmin, async (req, res) => {
  const { error, value } = adminTaskFilterSchema.validate(req.query, { stripUnknown: true });
  if (error) return res.status(400).json({ message: 'Invalid filters' });
  
  const tasks = await Task.find(value)
    .populate('client', 'name company mobile email guestInfo')
    .populate('student', 'name email mobile')
    .sort({ createdAt: -1 });
  return res.json(tasks);
});

// =========================================================
// 3. STUDENT & CANDIDATE MANAGEMENT
// =========================================================

/**
 * REWRITTEN CANDIDATE SEARCH
 * Logic: Filters by skills/location and sorts by tasksCompleted
 */
router.get('/tasks/:id/candidates', verifyJWT, ensureAdmin, async (req, res) => {
    try {
      const taskId = normalizeId(req.params.id);
      const { location, skill } = req.query;
      
      const task = await Task.findById(taskId);
      if (!task) return res.status(404).json({ message: "Task not found" });

      let query = { role: 'student', isApproved: true };

      // Skill Filtering
      if (skill) {
          query.skills = { $in: [new RegExp(skill, 'i')] };
      } else {
          query.skills = { $in: task.requiredSkills };
      }

      // Location Filtering
      if (location) {
          query.location = new RegExp(location, 'i');
      }

      const students = await User.find(query)
        .select('name email mobile location skills tasksCompleted averageScore totalScoreCount')
        .sort({ tasksCompleted: -1 }); // Sort by tasks done

      return res.json(students);
    } catch (err) {
        return res.status(500).json({ message: "Failed to fetch candidates" });
    }
});

/**
 * COMPLETE STUDENT DETAILS
 * Logic: Fetches full profile and historical tasks
 */
router.get('/students/:id', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const studentId = normalizeId(req.params.id);
    const student = await User.findById(studentId).select('-password');
    if (!student) return res.status(404).json({ message: 'Student not found' });

    const history = await Task.find({ student: studentId })
      .select('title status budget createdAt feedback score')
      .sort({ createdAt: -1 });

    return res.json({
      student: student,
      history: history,
      totalTasks: history.length,
      completedTasks: history.filter(t => t.status === 'completed').length
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// =========================================================
// 4. TASK ACTIONS
// =========================================================

/**
 * TOGGLE SUBMISSION VISIBILITY
 * Admin grants the client permission to see student work
 */
router.patch('/tasks/:id/visibility', verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const taskId = normalizeId(req.params.id);
    const { error, value } = visibilitySchema.validate(req.body);
    if (error) return res.status(400).json({ message: "Invalid visibility value" });

    const task = await Task.findByIdAndUpdate(
      taskId, 
      { clientCanViewSubmission: value.canView }, 
      { new: true }
    );

    return res.json({ message: 'Visibility updated', canView: task.clientCanViewSubmission });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/tasks/:id/assign', verifyJWT, ensureAdmin, async (req, res) => {
  const taskId = normalizeId(req.params.id);
  const { error, value } = assignStudentSchema.validate(req.body);
  if (error) return res.status(400).json({ message: 'Student ID required' });

  const task = await Task.findById(taskId);
  task.requestedStudent = value.studentId;
  task.assignmentRequestStatus = 'request_sent';
  await task.save();
  
  await sendNotification(value.studentId, { 
    title: 'New Invitation', 
    body: `Task: ${task.title}`, 
    data: { type: 'task_request', taskId: task._id.toString() } 
  });
  return res.json({ message: 'Invitation sent', task });
});

router.patch('/users/:id/approve', verifyJWT, ensureAdmin, async (req, res) => {
  const targetId = normalizeId(req.params.id);
  const { error, value } = approveUserSchema.validate(req.body);
  if (error) return res.status(400).json({ message: 'Validation failed' });
  
  const user = await User.findByIdAndUpdate(targetId, { isApproved: value.isApproved }, { new: true });
  return res.json({ message: 'Status updated', user });
});

module.exports = router;