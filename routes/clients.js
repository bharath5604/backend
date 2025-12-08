// routes/clients.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Task = require('../models/Task');
const verifyJWT = require('../middleware/authMiddleware');

// GET /api/clients/:id/public-profile
router.get('/:id/public-profile', verifyJWT, async (req, res) => {
  try {
    const client = await User.findById(req.params.id).select(
      'name email company location domain description role'
    );
    if (!client || client.role !== 'client') {
      return res.status(404).json({ message: 'Client not found' });
    }

    const tasks = await Task.find({ client: client._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('title status rating domain createdAt');

    res.json({
      id: client._id,
      name: client.name,
      email: client.email,
      company: client.company || '',
      location: client.location || '',
      domain: client.domain || '',
      description: client.description || '',
      recentTasks: tasks,
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error fetching client profile', error: err.message });
  }
});

module.exports = router;
