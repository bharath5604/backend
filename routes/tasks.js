const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

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
  requiredSkills: Joi.array().items(Joi.string().max(100)).default([]),
  company: Joi.string().max(200).allow('', null),

  // attachments uploaded by client (Firebase Storage URLs + names)
  attachments: Joi.array().items(Joi.string().uri().max(2000)).default([]),
  attachmentNames: Joi.array().items(Joi.string().max(255)).default([]),
});

const rateSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
});

// score now 1–5, same as rating
const feedbackSchema = Joi.object({
  text: Joi.string().max(2000).allow('', null),
  score: Joi.number().integer().min(1).max(5).required(),
});

// submission schema (student submit work)
const submissionSchema = Joi.object({
  fileUrl: Joi.string().uri().max(2000).required(),
  notes: Joi.string().max(2000).allow('', null),
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
      company,
      attachments,
      attachmentNames,
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
      location: location || client.location,
      domain: domain || client.domain,
      company: company || client.company,
      requiredSkills: requiredSkills || [],
      status: 'open',
      // attempts tracking uses schema defaults (attemptCount=0, maxAttempts=3)
      attachments: attachments || [],
      attachmentNames: attachmentNames || [],
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
    const { location, domain, company, minBudget, maxBudget } = req.query;

    const query = { status: 'open' };

    if (location) {
      query.location = location;
    }
    if (domain) {
      query.domain = domain;
    }
    if (company) {
      query.company = company;
    }

    if (minBudget || maxBudget) {
      query.budget = {};
      if (minBudget) query.budget.$gte = Number(minBudget);
      if (maxBudget) query.budget.$lte = Number(maxBudget);
    }

    if (req.user.role === 'student') {
      const student = await User.findById(req.user.id).select('skills');
      console.log('Student skills:', student?.skills);

      if (student && Array.isArray(student.skills) && student.skills.length > 0) {
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

// GET /api/tasks/search
router.get('/search', verifyJWT, async (req, res) => {
  try {
    const { domain, minBudget, maxBudget } = req.query;

    const filter = { status: 'open' };

    if (domain) filter.domain = domain;

    if (minBudget || maxBudget) {
      filter.budget = {};
      if (minBudget) filter.budget.$gte = Number(minBudget);
      if (maxBudget) filter.budget.$lte = Number(maxBudget);
    }

    const tasks = await Task.find(filter).populate('client', 'name company');

    res.json(tasks);
  } catch (err) {
    console.error('Error in GET /api/tasks/search:', err);
    res.status(500).json({
      message: 'Error searching tasks',
      error: err.message,
    });
  }
});

// GET /api/tasks/recommended (latest 5 based on student skills)
router.get('/recommended', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
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

    // Only return tasks that are still active for the student
    const tasks = await Task.find({
      _id: { $in: taskIds },
      status: { $in: ['assigned', 'under_review', 'completed'] }, // exclude 'declined'
    })
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

// NEW: GET /api/tasks/:id/candidates
// Candidate students for a task (after creation) based on requiredSkills, sorted by rating & tasksCompleted
router.get('/:id/candidates', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res
        .status(403)
        .json({ message: 'Only clients can view candidates' });
    }

    const task = await Task.findById(req.params.id).select('requiredSkills client status');
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (task.client.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not your task' });
    }

    // Optional: only show candidates for open tasks
    if (task.status !== 'open') {
      return res.status(400).json({ message: 'Task is not open anymore' });
    }

    const match = { role: 'student' };
    if (Array.isArray(task.requiredSkills) && task.requiredSkills.length > 0) {
      match.skills = { $in: task.requiredSkills };
    }

    const students = await User.aggregate([
      { $match: match },
      {
        $addFields: {
          averageScore: {
            $cond: [
              { $gt: ['$totalScoreCount', 0] },
              { $divide: ['$totalScore', '$totalScoreCount'] },
              0,
            ],
          },
        },
      },
      {
        $sort: {
          averageScore: -1,
          tasksCompleted: -1,
        },
      },
      { $limit: 50 },
      {
        $project: {
          name: 1,
          skills: 1,
          tasksCompleted: 1,
          totalScore: 1,
          totalScoreCount: 1,
          averageScore: 1,
        },
      },
    ]);

    res.json(students);
  } catch (err) {
    console.error('Error in GET /api/tasks/:id/candidates:', err);
    res.status(500).json({
      message: 'Error loading candidates',
      error: err.message,
    });
  }
});

// POST /api/tasks/:id/submit (student submits work)
router.post('/:id/submit', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res
        .status(403)
        .json({ message: 'Only students can submit work' });
    }

    const { error, value } = submissionSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const task = await Task.findById(req.params.id).populate('client', 'name');
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Only assigned student should submit (via accepted bid)
    const acceptedBid = await Bid.findOne({
      task: task._id,
      student: req.user.id,
      status: 'accepted',
    });

    if (!acceptedBid) {
      return res
        .status(403)
        .json({ message: 'You are not the accepted student for this task' });
    }

    // Block if no more attempts or task closed
    if (
      task.attemptCount >= (task.maxAttempts || 3) ||
      task.status === 'completed' ||
      task.status === 'declined'
    ) {
      return res
        .status(400)
        .json({ message: 'No more submissions allowed for this task' });
    }

    // prevent double active submission; after decline we clear submission
    if (task.submission && task.submission.student) {
      return res
        .status(400)
        .json({ message: 'Already submitted for this task' });
    }

    task.submission = {
      student: req.user.id,
      fileUrl: value.fileUrl,
      notes: value.notes || '',
      approved: false,
      submittedAt: new Date(),
    };
    task.status = 'under_review';
    await task.save();

    // notify client
    await sendNotification(task.client, {
      title: 'New submission received',
      body: `A submission was made for "${task.title}".`,
      data: {
        type: 'task_submitted',
        taskId: task._id.toString(),
      },
    });

    res.json({ message: 'Submission saved', task });
  } catch (err) {
    console.error('Error in POST /api/tasks/:id/submit:', err);
    res.status(500).json({
      message: 'Error submitting work',
      error: err.message,
    });
  }
});

// POST /api/tasks/:id/approve
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

    // mark as approved/completed
    task.submission.approved = true;
    task.status = 'completed';
    await task.save();

    // update student stats and mark related payment as held (waiting admin release)
    if (task.submission.student) {
      const student = await User.findById(task.submission.student);
      if (student) {
        student.tasksCompleted = (student.tasksCompleted || 0) + 1;
        await student.save();

        // find payment for this task & student that is still non-final
        const payment = await Payment.findOne({
          task: task._id,
          student: student._id,
          status: { $in: ['created', 'held'] },
        });

        if (payment) {
          // move to held; admin will later set 'completed' and credit wallet
          payment.status = 'held';
          await payment.save();
        }

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
    console.error('Error in POST /api/tasks/:id/approve:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/tasks/:id/decline  (3-attempts + payments aware)
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
    if (!task.submission || !task.submission.student) {
      return res
        .status(400)
        .json({ message: 'No submission to decline' });
    }

    const maxAttempts = task.maxAttempts || 3;

    // increment attempts
    task.attemptCount = (task.attemptCount || 0) + 1;

    // keep student; clear current submission so they can resubmit if allowed
    const declinedStudent = task.submission.student;
    task.submission = null;

    if (task.attemptCount >= maxAttempts) {
      // final decline: lock task and cancel payments
      task.status = 'declined';

      await Payment.updateMany(
        {
          task: task._id,
          student: declinedStudent,
          status: { $in: ['created', 'held'] },
        },
        {
          $set: {
            status: 'cancelled',
            declineReason:
              reason ||
              'Declined by client after maximum allowed attempts',
          },
        }
      );
    } else {
      // allow further attempt with same student
      task.status = 'assigned';
    }

    await task.save();

    // notify student
    await sendNotification(declinedStudent, {
      title:
        task.status === 'declined'
          ? 'Task permanently declined'
          : 'Task submission declined',
      body:
        task.status === 'declined'
          ? `Your submission for "${task.title}" was declined after multiple attempts.${
              reason ? ' Reason: ' + reason : ''
            }`
          : `Your submission for "${task.title}" was declined.${reason ? ' Reason: ' + reason : ''}`,
      data: {
        type: 'task_declined',
        taskId: task._id.toString(),
      },
    });

    res.json({
      message:
        task.status === 'declined'
          ? 'Task declined finally, no more attempts allowed'
          : 'Submission declined, student can resubmit',
      task,
    });
  } catch (err) {
    console.error('Error in POST /api/tasks/:id/decline:', err);
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

    const cleanScore = value.score; // 1–5

    const student = await User.findById(task.submission.student);
    if (!student) {
      return res
        .status(404)
        .json({ message: 'Student not found for this task' });
    }

    console.log('feedbackEntries before check:', student.feedbackEntries);

    // --- find previous feedback for this task+client (if any) ---
    let previousScoreForTask = 0;
    let previousDomain = task.domain || 'general';

    if (Array.isArray(student.feedbackEntries)) {
      const prev = student.feedbackEntries.find(
        (entry) =>
          entry.taskId.toString() === task._id.toString() &&
          entry.clientId.toString() === req.user.id.toString()
      );
      if (prev) {
        previousScoreForTask = prev.rating || 0;
        previousDomain = prev.domain || previousDomain;
      }
    }

    // store feedback on task
    task.feedback = value.text || '';
    task.score = cleanScore;
    task.rating = cleanScore;
    await task.save();

    // overall totals (score is 1–5), adjust for previous score if existed
    const safeTotalScore = student.totalScore || 0;
    const safeTotalCount = student.totalScoreCount || 0;

    student.totalScore = safeTotalScore - previousScoreForTask + cleanScore;
    if (previousScoreForTask === 0) {
      student.totalScoreCount = safeTotalCount + 1;
    } else {
      student.totalScoreCount = safeTotalCount; // count unchanged on overwrite
    }

    // per-domain feedback (adjust old domain entry if needed)
    const domain = task.domain || 'general';
    if (!Array.isArray(student.feedbackScores)) {
      student.feedbackScores = [];
    }

    // adjust previous domain entry if previous feedback existed
    if (previousScoreForTask > 0) {
      const prevDomEntry = student.feedbackScores.find(
        (e) => e.domain === previousDomain
      );
      if (prevDomEntry) {
        prevDomEntry.totalScore -= previousScoreForTask;
        // count unchanged because it's still one feedback in that domain
        if (prevDomEntry.totalScore < 0) prevDomEntry.totalScore = 0;
      }
    }

    // now add to current domain
    let aggEntry = student.feedbackScores.find((e) => e.domain === domain);
    if (!aggEntry) {
      student.feedbackScores.push({
        domain,
        totalScore: cleanScore,
        count: 1,
      });
    } else {
      aggEntry.totalScore += cleanScore;
      if (previousScoreForTask === 0) {
        aggEntry.count += 1;
      }
    }

    // detailed feedback entry for student's own profile:
    // keep only the latest feedback per task+client
    if (!Array.isArray(student.feedbackEntries)) {
      student.feedbackEntries = [];
    } else {
      student.feedbackEntries = student.feedbackEntries.filter(
        (entry) =>
          entry.taskId.toString() !== task._id.toString() ||
          entry.clientId.toString() !== req.user.id.toString()
      );
    }

    const client = await User.findById(task.client).select('name');

    student.feedbackEntries.push({
      taskId: task._id,
      taskTitle: task.title,
      clientId: task.client,
      clientName: client ? client.name : 'Client',
      rating: cleanScore,
      comment: value.text || '',
      domain,
      createdAt: new Date(),
    });

    await student.save();

    const avgScore =
      student.totalScoreCount > 0
        ? student.totalScore / student.totalScoreCount
        : 0;

    const domainEntry = student.feedbackScores.find(
      (e) => e.domain === domain
    );
    const domainAvg =
      domainEntry && domainEntry.count > 0
        ? domainEntry.totalScore / domainEntry.count
        : 0;

    return res.status(201).json({
      message: 'Feedback saved',
      taskId: task._id,
      studentId: student._id,
      totalScore: student.totalScore,
      totalScoreCount: student.totalScoreCount,
      averageScore: avgScore, // 0–5
      domain,
      domainAverageScore: domainAvg, // 0–5
    });
  } catch (err) {
    console.error('Error in POST /api/tasks/:id/feedback:', err);
    res.status(500).json({
      message: 'Error saving feedback',
      error: err.message,
    });
  }
});

// DELETE /api/tasks/:id -> delete task (client only)
router.delete('/:id', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ message: 'Only clients can delete tasks' });
    }

    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.client.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not your task' });
    }

    await Bid.deleteMany({ task: task._id });
    await Payment.deleteMany({ task: task._id });
    await task.deleteOne();

    res.json({ message: 'Task deleted' });
  } catch (err) {
    console.error('Error deleting task:', err);
    res
      .status(500)
      .json({ message: 'Error deleting task', error: err.message });
  }
});

module.exports = router;