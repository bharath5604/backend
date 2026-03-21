// routes/taskrequests.js
const express = require('express');
const router = express.Router();
const Joi = require('joi');
const mongoose = require('mongoose');

const Task = require('../models/Task');
const TaskRequest = require('../models/TaskRequest');
const User = require('../models/User');
const Bid = require('../models/Bid');
const verifyJWT = require('../middleware/authMiddleware');
const { sendNotification } = require('../utils/fcm');

// Joi schemas
const createRequestSchema = Joi.object({
  taskId: Joi.string().required(),
  studentIds: Joi.array().items(Joi.string().required()).min(1).required(),
  message: Joi.string().max(2000).allow('', null),
});

// POST /api/task-requests
// Client selects students after creating a task
router.post('/', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ message: 'Only clients can send requests' });
    }

    const { error, value } = createRequestSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const { taskId, studentIds, message } = value;

    const task = await Task.findById(taskId).select('title client status');
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (task.client.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not your task' });
    }

    // Optional: only allow requests for open tasks
    if (task.status !== 'open') {
      return res.status(400).json({ message: 'Task is not open for requests' });
    }

    const requests = [];
    for (const sid of studentIds) {
      const tr = await TaskRequest.create({
        task: task._id,
        client: req.user.id,
        student: sid,
        message: message || `Client invited you to work on "${task.title}".`,
      });
      requests.push(tr);

      // notify each student
      await sendNotification(sid, {
        title: 'New task request',
        body: `You have been invited to work on "${task.title}".`,
        data: {
          type: 'task_request',
          taskId: task._id.toString(),
          requestId: tr._id.toString(),
        },
      });
    }

    res.status(201).json({ message: 'Requests sent', requests });
  } catch (err) {
    console.error('Error in POST /api/task-requests:', err);
    res
      .status(500)
      .json({ message: 'Error sending requests', error: err.message });
  }
});

// GET /api/task-requests/mine
// Student workspace: view pending requests
router.get('/mine', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res
        .status(403)
        .json({ message: 'Only students can view requests' });
    }

    const studentId = new mongoose.Types.ObjectId(req.user.id);

    const requests = await TaskRequest.find({
      student: studentId,
      status: 'pending',
    })
      .populate('task', 'title description budget deadline requiredSkills status')
      .populate('client', 'name company')
      .sort({ createdAt: -1 });

    res.json(requests);
  } catch (err) {
    console.error('Error in GET /api/task-requests/mine:', err);
    res.status(500).json({
      message: 'Error loading requests',
      error: err.message,
    });
  }
});

// POST /api/task-requests/:id/accept
// Student accepts a request; others are cancelled and task assigned
router.post('/:id/accept', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res
        .status(403)
        .json({ message: 'Only students can accept requests' });
    }

    const request = await TaskRequest.findById(req.params.id).populate('task');
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (request.student.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not your request' });
    }
    if (request.status !== 'pending') {
      return res
        .status(400)
        .json({ message: 'Request already processed' });
    }

    const task = request.task;
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.status !== 'open') {
      return res
        .status(400)
        .json({ message: 'Task is not open anymore' });
    }

    // 1) Mark this request accepted
    request.status = 'accepted';
    await request.save();

    // 2) Cancel all other pending requests for this task
    await TaskRequest.updateMany(
      {
        task: task._id,
        _id: { $ne: request._id },
        status: 'pending',
      },
      { $set: { status: 'cancelled' } }
    );

    // 3) Create or update an accepted Bid for this student
    let bid = await Bid.findOne({
      task: task._id,
      student: req.user.id,
    });

    if (!bid) {
      bid = await Bid.create({
        task: task._id,
        student: req.user.id,
        quote: task.budget, // default to task budget; you can adjust later
        timeline: task.deadline,
        status: 'accepted',
      });
    } else {
      bid.status = 'accepted';
      await bid.save();
    }

    // 4) Update task: assign student + set status
    task.status = 'assigned';
    task.student = req.user.id; // IMPORTANT: link accepted student here
    await task.save();

    // 5) Notify client that a student accepted
    await sendNotification(task.client, {
      title: 'Task request accepted',
      body: `A student accepted your request for "${task.title}".`,
      data: {
        type: 'task_request_accepted',
        taskId: task._id.toString(),
        studentId: req.user.id.toString(),
      },
    });

    res.json({
      message: 'Request accepted',
      taskId: task._id,
      bidId: bid._id,
    });
  } catch (err) {
    console.error('Error in POST /api/task-requests/:id/accept:', err);
    res.status(500).json({
      message: 'Error accepting request',
      error: err.message,
    });
  }
});

// POST /api/task-requests/:id/decline
// Student declines a request → it disappears from workspace
router.post('/:id/decline', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res
        .status(403)
        .json({ message: 'Only students can decline requests' });
    }

    const request = await TaskRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (request.student.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not your request' });
    }
    if (request.status !== 'pending') {
      return res
        .status(400)
        .json({ message: 'Request already processed' });
    }

    request.status = 'declined';
    await request.save();

    res.json({ message: 'Request declined' });
  } catch (err) {
    console.error('Error in POST /api/task-requests/:id/decline:', err);
    res.status(500).json({
      message: 'Error declining request',
      error: err.message,
    });
  }
});

module.exports = router;