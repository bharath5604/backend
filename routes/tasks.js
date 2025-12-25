const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Bid = require('../models/Bid');
const verifyJWT = require('../middleware/authMiddleware');
const Joi = require('joi');
const { sendNotification } = require('../utils/fcm');

// Joi schemas
const createTaskSchema = Joi.object({
  title: Joi.string().min(3).max(200).required(),
  description: Joi.string().min(10).max(2000).required(),
  budget: Joi.number().positive().max(1_000_000).required(),
  deadline: Joi.string().max(50).required(),
  location: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  // required skills for this task (multi-select from client UI)
  requiredSkills: Joi.array().items(Joi.string().max(100)).default([]),
});

const rateSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
});

const feedbackSchema = Joi.object({
  text: Joi.string().max(2000).allow('', null),
  score: Joi.number().integer().min(0).max(10).required(),
});

// POST /api/tasks/create -> create new task (client)
router.post('/create', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res
        .status(403)
        .json({ message: 'Only clients can create tasks' });
    }

    const { error, value } = createTaskSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const {
      title,
      description,
      budget,
      deadline,
      location,
      domain,
      requiredSkills,
    } = value;

    const client = await User.findById(req.user.id).select(
      'company location domain'
    );
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    const task = await Task.create({
      title,
      description,
      budget,
      deadline,
      client: req.user.id,
      // if client leaves location/domain empty, fallback to their profile defaults
      location: location || client.location,
      domain: domain || client.domain,
      company: client.company,
      requiredSkills: requiredSkills || [],
      status: 'open',
    });

    res.json(task);
  } catch (err) {
    res.status(400).json({
      message: 'Error creating task',
      error: err.message,
    });
  }
});

// GET /api/tasks (student feed + filters)
router.get('/', verifyJWT, async (req, res) => {
  try {
    const { location, domain, company } = req.query;

    // Base query: only open tasks
    const query = { status: 'open' };

    // Optional filters from UI
    if (location) {
      query.location = location;
    }
    if (domain) {
      query.domain = domain;
    }
    if (company) {
      query.company = company;
    }

    // If logged-in user is a student, filter by their skills vs task.requiredSkills
    if (req.user.role === 'student') {
      const student = await User.findById(req.user.id).select('skills');
      console.log('Student skills:', student?.skills);

      if (student && Array.isArray(student.skills) && student.skills.length > 0) {
        // only tasks whose requiredSkills intersect with student's skills
        query.requiredSkills = { $in: student.skills };
      }
    }

    console.log('Tasks feed query:', query);

    const tasks = await Task.find(query).populate('client', 'name company');

    res.json(tasks);
  } catch (err) {
    console.error('Error in GET /api/tasks:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// GET /api/tasks/recommended (latest 5 based on student skills)
router.get('/recommended', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      // only meaningful for students; others get empty list
      return res.json([]);
    }

    const student = await User.findById(req.user.id).select('skills');
    if (!student || !Array.isArray(student.skills) || student.skills.length === 0) {
      return res.json([]);
    }

    const query = {
      status: 'open',
      requiredSkills: { $in: student.skills },
    };

    const tasks = await Task.find(query)
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('client', 'name company');

    res.json(tasks);
  } catch (err) {
    console.error('Error in GET /api/tasks/recommended:', err);
    res
      .status(500)
      .json({ message: 'Error fetching recommended tasks', error: err.message });
  }
});

// GET /api/tasks/assigned (student workspace)
router.get('/assigned', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res
        .status(403)
        .json({ message: 'Only students can view assigned tasks' });
    }

    const acceptedBids = await Bid.find({
      student: req.user.id,
      status: 'accepted',
    }).select('task');

    if (acceptedBids.length === 0) {
      return res.json([]);
    }

    const taskIds = acceptedBids.map((b) => b.task);
    const tasks = await Task.find({ _id: { $in: taskIds } })
      .populate('client', 'name company location')
      .lean();

    res.json(tasks);
  } catch (err) {
    console.error('Error in GET /api/tasks/assigned:', err);
    res
      .status(500)
      .json({ message: 'Server error', error: err.message });
  }
});

// GET /api/tasks/mine (client’s tasks, with bidsCount)
router.get('/mine', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res
        .status(403)
        .json({ message: 'Only clients can view their tasks' });
    }

    const tasks = await Task.find({ client: req.user.id })
      .populate('client', 'name company')
      .lean();

    if (tasks.length === 0) {
      return res.json([]);
    }

    const taskIds = tasks.map((t) => t._id);

    const counts = await Bid.aggregate([
      { $match: { task: { $in: taskIds } } },
      {
        $group: {
          _id: '$task',
          count: { $sum: 1 },
        },
      },
    ]);

    const countMap = {};
    for (const c of counts) {
      countMap[c._id.toString()] = c.count;
    }

    const enriched = tasks.map((t) => ({
      ...t,
      bidsCount: countMap[t._id.toString()] || 0,
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Error in GET /api/tasks/mine:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/tasks/:id/approve -> mark task completed + release payment
router.post('/:id/approve', verifyJWT, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id).populate(
      'submission.student',
      'name'
    );

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (task.client.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ message: 'Not allowed to approve this task' });
    }
    if (!task.submission || !task.submission.fileUrl) {
      return res.status(400).json({ message: 'No submission to approve' });
    }

    task.submission.approved = true;
    task.status = 'completed';
    await task.save();

    const payment = await Payment.findOne({
      task: task._id,
      status: 'held',
    });

    if (payment) {
      payment.status = 'released';
      await payment.save();

      const student = await User.findById(payment.student);
      if (student) {
        const credit = payment.netToStudent || payment.amount || 0;
        student.wallet = (student.wallet || 0) + credit;
        await student.save();

        await sendNotification(student._id, {
          title: 'Task approved',
          body: `Your submission for "${task.title}" was approved.`,
          data: {
            type: 'task_approved',
            taskId: task._id.toString(),
          },
        });
      }
    }

    res.json({ message: 'Task approved', task });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/tasks/:id/decline -> mark payment declined with reason
router.post('/:id/decline', verifyJWT, async (req, res) => {
  try {
    const { reason } = req.body;

    const task = await Task.findById(req.params.id);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (task.client.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ message: 'Not allowed to decline this task' });
    }

    const payment = await Payment.findOne({
      task: task._id,
      status: 'held',
    });

    if (!payment) {
      return res
        .status(404)
        .json({ message: 'No held payment found for this task' });
    }

    payment.status = 'declined';
    payment.declineReason = reason || 'Not satisfactory';
    await payment.save();

    task.status = 'open'; // or 'rejected'
    await task.save();

    await sendNotification(payment.student, {
      title: 'Task declined',
      body: `Your submission for "${task.title}" was declined.`,
      data: {
        type: 'task_declined',
        taskId: task._id.toString(),
      },
    });

    res.json({ message: 'Payment declined', payment });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/tasks/:id/rate
router.post('/:id/rate', verifyJWT, async (req, res) => {
  try {
    const { error, value } = rateSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const task = await Task.findById(req.params.id);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (task.client.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ message: 'Not allowed to rate this task' });
    }

    task.rating = value.rating;
    await task.save();

    res.json({ message: 'Task rated', task });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/tasks/:id/feedback
router.post('/:id/feedback', verifyJWT, async (req, res) => {
  try {
    const { error, value } = feedbackSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    if (req.user.role !== 'client') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    if (task.client.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not your task' });
    }

    if (!task.submission || !task.submission.student) {
      return res
        .status(400)
        .json({ message: 'No submitted student to rate' });
    }

    const cleanScore = value.score;

    task.feedback = value.text || '';
    task.score = cleanScore;
    await task.save();

    const student = await User.findById(task.submission.student);
    if (!student) {
      return res
        .status(404)
        .json({ message: 'Student not found for this task' });
    }

    student.totalScore = (student.totalScore || 0) + cleanScore;
    student.totalScoreCount = (student.totalScoreCount || 0) + 1;

    const domain = task.domain || 'general';
    if (!Array.isArray(student.feedbackScores)) {
      student.feedbackScores = [];
    }
    const entry = student.feedbackScores.find((e) => e.domain === domain);
    if (!entry) {
      student.feedbackScores.push({
        domain,
        totalScore: cleanScore,
        count: 1,
      });
    } else {
      entry.totalScore += cleanScore;
      entry.count += 1;
    }

    await student.save();

    res.json({ message: 'Feedback saved', task });
  } catch (err) {
    res.status(500).json({
      message: 'Error saving feedback',
      error: err.message,
    });
  }
});

module.exports = router;
