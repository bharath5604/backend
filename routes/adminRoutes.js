const express = require('express');
const router = express.Router();

const adminController = require('../controllers/adminController');
const auth = require('../middleware/authMiddleware');

/*
=====================================
ADMIN CHECK
=====================================
*/
const ensureAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin only' });
  }
  next();
};

/*
=====================================
COMPLETED TASKS
URL: /api/admin/tasks/completed
=====================================
*/
router.get(
  '/completed',
  auth,
  ensureAdmin,
  adminController.getCompletedTasks
);

/*
=====================================
PENDING PAYMENTS
URL: /api/admin/tasks/pending-payments
=====================================
*/
router.get(
  '/pending-payments',
  auth,
  ensureAdmin,
  adminController.getPendingPayments
);

/*
=====================================
PAY STUDENT FOR TASK
URL: /api/admin/tasks/pay/:taskId
=====================================
*/
router.put(
  '/pay/:taskId',
  auth,
  ensureAdmin,
  adminController.payStudent
);

module.exports = router;
