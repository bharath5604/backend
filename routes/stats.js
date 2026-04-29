//backend/routes/stats.js
const express = require('express');
const router = express.Router();

const User = require('../models/User');
const Task = require('../models/Task');

function toSafeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// GET /api/stats -> high-level platform stats for landing page
router.get('/', async (req, res) => {
  try {
    const [
      studentCount,
      clientCount,
      totalTaskCount,
      completedTaskCount,
      assignedTaskCount,
      openTaskCount,
    ] = await Promise.all([
      User.countDocuments({ role: 'student' }),
      User.countDocuments({ role: 'client' }),
      Task.countDocuments({}),
      Task.countDocuments({ status: 'completed' }),
      Task.countDocuments({ status: 'assigned' }),
      Task.countDocuments({ status: 'open' }),
    ]);

    return res.json({
      students: toSafeNumber(studentCount),
      clients: toSafeNumber(clientCount),
      tasks: toSafeNumber(totalTaskCount),
      completedTasks: toSafeNumber(completedTaskCount),
      assignedTasks: toSafeNumber(assignedTaskCount),
      openTasks: toSafeNumber(openTaskCount),
    });
  } catch (err) {
    console.error('Error in GET /api/stats', err);
    return res.status(500).json({
      message: 'Error loading stats',
      error: err.message,
    });
  }
});

module.exports = router;