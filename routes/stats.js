const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Task = require('../models/Task');
const Bid = require('../models/Bid'); // if you have a Bid model

// GET /api/stats -> high-level platform stats for landing page
router.get('/', async (req, res) => {
  try {
    const [studentCount, clientCount, taskCount, bidCount] = await Promise.all([
      User.countDocuments({ role: 'student' }),
      User.countDocuments({ role: 'client' }),
      Task.countDocuments({}),
      Bid.countDocuments({}), // or {} or { status: 'open' } etc.
    ]);

    res.json({
      students: studentCount,
      clients: clientCount,
      projects: taskCount,
      bids: bidCount,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error loading stats', error: err.message });
  }
});

module.exports = router;
