//backend/routes/clients.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Task = require('../models/Task');
const verifyJWT = require('../middleware/authMiddleware');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeId(value) {
  return clean(value);
}

// GET /api/clients/:id/public-profile
router.get('/:id/public-profile', verifyJWT, async (req, res) => {
  try {
    const clientId = normalizeId(req.params.id);

    if (!clientId) {
      return res.status(400).json({ message: 'Client ID is required' });
    }

    const client = await User.findById(clientId).select(
      'name email company location domain description role'
    );

    if (!client || client.role !== 'client') {
      return res.status(404).json({ message: 'Client not found' });
    }

    const tasks = await Task.find({ client: client._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('title status rating domain createdAt');

    const recentTasks = tasks.map((task) => ({
      id: task._id,
      title: clean(task.title),
      status: clean(task.status),
      rating: task.rating ?? null,
      domain: clean(task.domain),
      createdAt: task.createdAt,
    }));

    return res.json({
      id: client._id,
      name: clean(client.name),
      email: clean(client.email),
      company: clean(client.company),
      location: clean(client.location),
      domain: clean(client.domain),
      description: clean(client.description),
      recentTasks,
    });
  } catch (err) {
    console.error('Error in GET /api/clients/:id/public-profile', err);
    return res.status(500).json({
      message: 'Error fetching client profile',
      error: err.message,
    });
  }
});

module.exports = router;