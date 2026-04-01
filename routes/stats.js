const express = require('express');
const router = express.Router();

const User = require('../models/User');
const Task = require('../models/Task');

// GET /api/stats -> high-level platform stats for landing page
router.get('/', async (req, res) => {
  try {
    const [studentCount, clientCount, taskCount] = await Promise.all([
      User.countDocuments({ role: 'student' }),
      User.countDocuments({ role: 'client' }),
      Task.countDocuments({}),
    ]);

    return res.json({
      students: studentCount,
      clients: clientCount,
      projects: taskCount,
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Error loading stats',
      error: err.message,
    });
  }
});

module.exports = router;