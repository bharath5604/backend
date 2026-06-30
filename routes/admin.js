// backend/routes/admin.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const verifyJWT = require('../middleware/authMiddleware');
const User = require('../models/User');

/**
 * Admin Role Guard 
 * Ensures that only users with the 'admin' role can access these routes.
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
// 1. DASHBOARD ANALYTICS & GLOBAL FILTERS
// =============================================================================

// GET /api/admin/stats/overview
router.get('/stats/overview', adminController.getOverviewStats);

// GET /api/admin/stats/growth?metric=tasks
router.get('/stats/growth', adminController.getGrowthStats);

// GET /api/admin/getTopStudents
router.get('/getTopStudents', adminController.getTopStudents);

// GET /api/admin/getTaskStats
router.get('/getTaskStats', adminController.getTaskStats);

// GET /api/admin/tasks/filters (For the main tasks registry page)
router.get('/tasks/filters', adminController.getTaskFilters);

/**
 * REQUIREMENT: GET /api/admin/student-filters
 * Logic: Returns unique technical skills from students and 
 * UNIQUE LOCATIONS FROM ALL USERS (Students and Clients).
 * This fixes the dropdowns in your candidate vetting UI.
 */

router.get('/student-filters', async (req, res) => {
    try {
        const [allLocations, studentSkills] = await Promise.all([
            User.distinct('location'), 
            User.distinct('skills', { role: 'student' }) 
        ]);
        
        // ============================================================
        // MODIFICATION: CASE-INSENSITIVE DUPLICATE REMOVAL
        // ============================================================
        const normalizedLocations = [...new Set(
            allLocations
                .filter(Boolean) // Remove null/undefined
                .map(loc => loc.trim()
                    .toLowerCase()
                    .split(' ')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ')
                )
        )].sort();

        const normalizedSkills = [...new Set(
            studentSkills
                .filter(Boolean)
                .map(skill => skill.trim()
                    .toLowerCase()
                    .split(' ')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ')
                )
        )].sort();
        
        res.json({ 
            locations: normalizedLocations, 
            skills: normalizedSkills 
        });
    } catch (err) {
        res.status(500).json({ message: "Error loading vetting filter options" });
    }
});
// =============================================================================
// 2. CHAT SUB-ROUTES (Moderated Communication)
// These handle the separate Admin-Client and Admin-Student threads for a task.
// =============================================================================

// Context: Admin communicating with the Client
router.get('/tasks/:taskId/chat/client/messages', adminController.getClientTaskMessages);
router.post('/tasks/:taskId/chat/client/messages', adminController.sendClientTaskMessage);

// Context: Admin vetting or guiding the Student
router.get('/tasks/:taskId/chat/student/messages', adminController.getStudentTaskMessages);
router.post('/tasks/:taskId/chat/student/messages', adminController.sendStudentTaskMessage);

// =============================================================================
// 3. RESOURCE REGISTRIES
// =============================================================================

// GET /api/admin/users (Managed User List with Multi-filters)
router.get('/users', async (req, res) => {
    const { role, location, company, domain } = req.query;
    const filter = { role: { $ne: 'admin' } };
    
    if (role && role !== 'All') {
        filter.role = role;
    }
    if (location) {
        filter.location = new RegExp(location, 'i');
    }
    if (company) {
        filter.company = new RegExp(company, 'i');
    }
    if (domain) {
        filter.$or = [
            { skills: { $in: [new RegExp(domain, 'i')] } },
            { domain: new RegExp(domain, 'i') }
        ];
    }

    try {
        const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: "Error fetching user list" });
    }
});

// GET /api/admin/tasks (Master project registry)
router.get('/tasks', adminController.getAllTasks);

// =============================================================================
// 4. PROJECT ACTIONS & HYBRID PAYMENTS
// =============================================================================

/**
 * MODIFICATION: Finalize Negotiated Budget
 * PATCH /api/admin/tasks/:taskId/finalize-budget
 * Finalizes the budget agreed in chat to enable Razorpay on the Client app.
 */
router.patch('/tasks/:taskId/finalize-budget', adminController.finalizeTaskBudget);

// Complete Student Profile + Full Project History
router.get('/students/:studentId', adminController.getStudentDetails);

// Suggested Candidates (Filtered by Location/Skill and Sorted by Experience)
router.get('/tasks/:taskId/candidates', adminController.getSuggestedStudents);

// Toggle Visibility: Grant/Revoke Client's permission to see work
router.patch('/tasks/:taskId/visibility', adminController.toggleSubmissionVisibility);

/**
 * MANUAL PAYMENT CHAIN STEP 1: Admin verifies Client paid Admin.
 */
router.patch('/tasks/:taskId/confirm-client-payment', adminController.confirmClientPayment);

/**
 * MANUAL PAYMENT CHAIN STEP 2: Admin verifies Admin paid Student.
 */
router.patch('/tasks/:taskId/confirm-student-payout', adminController.confirmStudentPayout);

/**
 * Formal Task Invitation
 */
router.post('/tasks/:taskId/assign', adminController.assignTaskToStudent);

// Generic Task Retrieval
router.get('/tasks/:taskId', adminController.getTaskById);

// PATCH /api/admin/users/:id/approve (Ban or Activate accounts)
router.patch('/users/:id/approve', adminController.updateUserApproval);

module.exports = router;