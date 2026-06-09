// backend/routes/admin.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const verifyJWT = require('../middleware/authMiddleware');

/**
 * Admin Role Guard 
 * Ensures that even with a valid JWT, only accounts with the 'admin' 
 * role can access these sensitive management endpoints.
 */
const ensureAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
  }
  next();
};

// Apply Authentication and Admin Authorization to ALL routes in this file
router.use(verifyJWT);
router.use(ensureAdmin);

// =============================================================================
// 1. STATIC ANALYTICS & GLOBAL FILTERS (TOP PRIORITY)
// These routes must be defined first to avoid being captured by /:taskId
// =============================================================================

// GET /api/admin/stats/overview
router.get('/stats/overview', adminController.getOverviewStats);

// GET /api/admin/stats/growth?metric=tasks
router.get('/stats/growth', adminController.getGrowthStats);

// GET /api/admin/tasks/filters (For the main tasks screen)
router.get('/tasks/filters', adminController.getTaskFilters);

/**
 * FIXED: GET /api/admin/student-filters
 * Logic: Returns unique technical skills and locations from all students.
 * Used to populate the Vetting Dropdowns in the Flutter UI.
 */
router.get('/student-filters', async (req, res) => {
    const User = require('../models/User');
    try {
        const [locs, skills] = await Promise.all([
            User.distinct('location', { role: 'student' }),
            User.distinct('skills', { role: 'student' })
        ]);
        res.json({ 
            locations: locs.filter(Boolean).sort(), 
            skills: skills.filter(Boolean).sort() 
        });
    } catch (err) {
        res.status(500).json({ message: "Error loading vetting options" });
    }
});

// GET /api/admin/getTopStudents
router.get('/getTopStudents', adminController.getTopStudents);

// GET /api/admin/getTaskStats
router.get('/getTaskStats', adminController.getTaskStats);

// =============================================================================
// 2. CHAT SUB-ROUTES (MEDIUM PRIORITY)
// Must be defined before the generic /tasks/:taskId route
// =============================================================================

// Context: Admin communicating with the Client
router.get('/tasks/:taskId/chat/client/messages', adminController.getClientTaskMessages);
router.post('/tasks/:taskId/chat/client/messages', adminController.sendClientTaskMessage);

// Context: Admin vetting or guiding the Student
router.get('/tasks/:taskId/chat/student/messages', adminController.getStudentTaskMessages);
router.post('/tasks/:taskId/chat/student/messages', adminController.sendStudentTaskMessage);

// =============================================================================
// 3. RESOURCE LISTS
// =============================================================================

// GET /api/admin/users?role=student
router.get('/users', async (req, res) => {
    const User = require('../models/User');
    const { role } = req.query;
    const filter = { role: { $ne: 'admin' } };
    if (role) filter.role = role;

    try {
        const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: "Error fetching user registry" });
    }
});

// GET /api/admin/tasks (Master registry including Emergency Guest tasks)
router.get('/tasks', adminController.getAllTasks);

// =============================================================================
// 4. PARAMETERIZED ACTIONS & PAYMENTS (LOW PRIORITY)
// =============================================================================

// Complete Student Profile + Full Project History
router.get('/students/:studentId', adminController.getStudentDetails);

// Suggested Candidates (Filtered by Location/Skill and Sorted by Experience)
router.get('/tasks/:taskId/candidates', adminController.getSuggestedStudents);

// Toggle Visibility: Grant/Revoke Client's permission to see work
router.patch('/tasks/:taskId/visibility', adminController.toggleSubmissionVisibility);

/**
 * MANUAL PAYMENT CHAIN STEP 1:
 * Admin verifies that the Client has scanned the QR and paid the Admin.
 */
router.patch('/tasks/:taskId/confirm-client-payment', adminController.confirmClientPayment);

/**
 * MANUAL PAYMENT CHAIN STEP 2:
 * Admin verifies that they have transferred the funds to the Student.
 */
router.patch('/tasks/:taskId/confirm-student-payout', adminController.confirmStudentPayout);

/**
 * Formal Task Invitation
 * Transitions task from 'open' to 'request_sent'
 */
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
      title: 'New Vetting Invitation',
      body: `Admin invited you to discuss: ${task.title}`,
      data: { type: 'task_request', taskId: task._id.toString() }
    });

    res.json({ message: 'Invitation sent to student', task });
  } catch (err) {
    res.status(500).json({ message: "Failed to process invitation" });
  }
});

// Generic Task Retrieval (Should be near the bottom)
router.get('/tasks/:taskId', adminController.getTaskById);

// PATCH /api/admin/users/:id/approve (Enable or Disable account)
router.patch('/users/:id/approve', adminController.updateUserApproval);

module.exports = router;