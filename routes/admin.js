// backend/routes/admin.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const verifyJWT = require('../middleware/authMiddleware');

/**
 * Admin Role Guard
 */
const ensureAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access restricted' });
  }
  next();
};

// Apply Auth and Admin guards to all routes in this file
router.use(verifyJWT);
router.use(ensureAdmin);

// =============================================================================
// 1. STATIC ANALYTICS & FILTERS (MUST BE AT THE TOP TO PREVENT 404)
// =============================================================================

// GET /api/admin/stats/overview
router.get('/stats/overview', adminController.getOverviewStats);

// GET /api/admin/stats/growth?metric=tasks
router.get('/stats/growth', adminController.getGrowthStats);

// GET /api/admin/tasks/filters
router.get('/tasks/filters', adminController.getTaskFilters);

// GET /api/admin/getTopStudents
router.get('/getTopStudents', adminController.getTopStudents);

// GET /api/admin/getTaskStats
router.get('/getTaskStats', adminController.getTaskStats);

// =============================================================================
// 2. RESOURCE LISTS
// =============================================================================

// GET /api/admin/users?role=student&location=...
router.get('/users', async (req, res) => {
    const User = require('../models/User');
    const { role, location, domain } = req.query;
    const filter = { role: { $ne: 'admin' } };
    
    if (role) filter.role = role;
    if (location) filter.location = new RegExp(location, 'i');
    if (domain) filter.skills = { $in: [new RegExp(domain, 'i')] };

    try {
        const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: "Error fetching users" });
    }
});

// GET /api/admin/tasks
router.get('/tasks', adminController.getCompletedTasks); // Re-using controller logic for list

// =============================================================================
// 3. PARAMETERIZED ROUTES (MUST BE AT THE BOTTOM)
// =============================================================================

// GET /api/admin/students/:studentId (Complete profile + History)
router.get('/students/:studentId', adminController.getStudentDetails);

// GET /api/admin/tasks/:taskId/candidates (Filtered & Sorted)
router.get('/tasks/:taskId/candidates', adminController.getSuggestedStudents);

// PATCH /api/admin/tasks/:taskId/visibility (Grant client permission)
router.patch('/tasks/:taskId/visibility', adminController.toggleSubmissionVisibility);

/**
 * PAYMENT CHAIN STEP 1:
 * Admin records that the Client has paid them (via QR).
 */
router.patch('/tasks/:taskId/confirm-client-payment', adminController.confirmClientPayment);

/**
 * PAYMENT CHAIN STEP 2:
 * Admin records that they have transferred funds to the Student.
 */
router.patch('/tasks/:taskId/confirm-student-payout', adminController.confirmStudentPayout);

// POST /api/admin/tasks/:taskId/assign (Invite student)
router.post('/tasks/:taskId/assign', async (req, res) => {
  const Task = require('../models/Task');
  const { sendNotification } = require('../utils/fcm');
  const { studentId } = req.body;

  try {
    const task = await Task.findById(req.params.taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    task.requestedStudent = studentId;
    task.assignmentRequestStatus = 'request_sent';
    await task.save();

    await sendNotification(studentId, {
      title: 'New Opportunity',
      body: `You have been invited to: ${task.title}`,
      data: { type: 'task_request', taskId: task._id.toString() }
    });

    res.json({ message: 'Invitation sent', task });
  } catch (err) {
    res.status(500).json({ message: "Assignment failed" });
  }
});

// PATCH /api/admin/users/:id/approve (Ban/Activate)
router.patch('/users/:id/approve', adminController.updateUserApproval);

module.exports = router;