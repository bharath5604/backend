const Task = require('../models/Task');
const User = require('../models/User');

// Helper for numeric parsing
const asNumber = (val) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

/**
 * ==========================================
 * CREATE TASK (Registered Client)
 * ==========================================
 */
exports.createTask = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'client') {
      return res.status(403).json({ message: 'Only clients can create tasks' });
    }

    const {
      title,
      description,
      budget, 
      deadline,
      location,
      domain,
      company,
      requiredSkills,
      attachments,
      attachmentNames,
    } = req.body;

    if (!title || !description || !deadline) {
      return res.status(400).json({ message: 'Title, description and deadline are required' });
    }

    const task = await Task.create({
      title: title.trim(),
      description: description.trim(),
      budget: asNumber(budget), 
      deadline: new Date(deadline),
      location: String(location || '').trim(),
      domain: String(domain || '').trim(),
      company: String(company || '').trim(),
      requiredSkills: Array.isArray(requiredSkills) ? requiredSkills : [],
      attachments: Array.isArray(attachments) ? attachments : [],
      attachmentNames: Array.isArray(attachmentNames) ? attachmentNames : [],
      client: req.user.id,
      isGuestTask: false,
      status: 'open'
    });

    return res.status(201).json({ message: 'Task created successfully', task });
  } catch (err) {
    console.error('Create Task Error:', err);
    return res.status(500).json({ message: 'Failed to create task', error: err.message });
  }
};

/**
 * ==========================================
 * CREATE GUEST TASK (Landing Page Emergency)
 * ==========================================
 */
exports.createGuestTask = async (req, res) => {
  try {
    const {
      title,
      description,
      guestName,
      guestMobile,
      guestEmail,
      budget,
      deadline,
      domain,
      requiredSkills
    } = req.body;

    if (!title || !description || !guestName || !guestMobile || !deadline) {
      return res.status(400).json({ message: 'Missing required guest task fields' });
    }

    const task = await Task.create({
      title: title.trim(),
      description: description.trim(),
      isGuestTask: true,
      guestInfo: {
        name: guestName.trim(),
        mobile: guestMobile.trim(),
        email: (guestEmail || '').trim()
      },
      budget: asNumber(budget),
      deadline: new Date(deadline),
      domain: domain || 'General',
      requiredSkills: requiredSkills || [],
      status: 'open'
    });

    return res.status(201).json({
      message: 'Emergency task submitted. Admin will contact you shortly.',
      task
    });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to submit guest task', error: err.message });
  }
};

/**
 * ==========================================
 * RATE STUDENT & UPDATE REPUTATION ARRAYS
 * FIXED: Explicitly pushing into 'feedback' and 'feedbackScores'
 * ==========================================
 */
// backend/controllers/taskController.js

exports.rateStudent = async (req, res) => {
  try {
    // 1. Get score from body (Flutter sends 'score')
    const scoreValue = Number(req.body.score);
    const feedbackText = req.body.text || req.body.feedback || '';

    // 2. NaN Safety Check
    if (isNaN(scoreValue)) {
      return res.status(400).json({ message: "Invalid score. Must be a number." });
    }

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (!task.student) return res.status(400).json({ message: 'No student assigned' });

    // 3. Update Task
    task.score = scoreValue;
    task.rating = scoreValue; // Keep both synced
    task.feedback = feedbackText;
    await task.save();

    // 4. Update Student Arrays
    const student = await User.findById(task.student);
    const client = await User.findById(req.user.id);

    if (student) {
      student.totalScore = (student.totalScore || 0) + scoreValue;
      student.totalScoreCount = (student.totalScoreCount || 0) + 1;

      // PUSH TO feedbackEntries (This makes it show on Dashboard)
      student.feedbackEntries.push({
        taskId: task._id,
        taskTitle: task.title,
        clientId: client._id,
        clientName: client.name,
        rating: scoreValue,
        comment: feedbackText,
        createdAt: new Date()
      });

      await student.save();
    }
    return res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * ===============================
 * GET ALL TASKS
 * ===============================
 */
exports.getAllTasks = async (req, res) => {
  try {
    const { clientId, domain } = req.query;
    const query = {};
    if (clientId) query.client = clientId;
    else query.status = 'open';

    if (domain) query.domain = String(domain).trim();

    const tasks = await Task.find(query)
      .populate('client', 'name email company')
      .sort({ createdAt: -1 });

    return res.json(tasks);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch tasks' });
  }
};

/**
 * ===============================
 * GET TASK BY ID
 * ===============================
 */
exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId)
      .populate('client', 'name email company mobile')
      .populate('student', 'name email mobile skills tasksCompleted');
    if (!task) return res.status(404).json({ message: 'Task not found' });
    return res.json(task);
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching task' });
  }
};

/**
 * ===============================
 * STUDENT SUBMIT WORK
 * ===============================
 */
exports.submitWork = async (req, res) => {
  try {
    const { fileUrl, notes } = req.body;
    const task = await Task.findById(req.params.taskId || req.params.id);

    if (!task || task.student?.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized submission' });
    }

    task.submission = {
      student: req.user.id,
      fileUrl: String(fileUrl || '').trim(),
      notes: String(notes || '').trim(),
      approved: false,
      submittedAt: new Date(),
    };

    task.status = 'under_review';
    task.clientCanViewSubmission = false; 

    await task.save();
    return res.json({ message: 'Work submitted for Admin review', task });
  } catch (err) {
    return res.status(500).json({ message: 'Submission failed' });
  }
};

/**
 * ===============================
 * CLIENT APPROVE WORK
 * ===============================
 */
exports.approveWork = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId || req.params.id);

    if (!task || (task.client && task.client.toString() !== req.user.id)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    if (!task.submission) {
      return res.status(400).json({ message: 'No work found to approve' });
    }

    task.submission.approved = true;
    task.submission.clientApprovedAt = new Date();
    task.status = 'completed';

    await task.save();

    // REQUIREMENT: Increment student completion counter
    const student = await User.findById(task.student);
    if (student) {
      student.tasksCompleted = (student.tasksCompleted || 0) + 1;
      await student.save();
    }

    return res.json({ message: 'Work approved. Payout process initiated.', task });
  } catch (err) {
    return res.status(500).json({ message: 'Approval failed' });
  }
};

/**
 * ===============================
 * CLIENT DECLINE / REVISION
 * ===============================
 */
exports.declineWork = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId || req.params.id);
    if (!task || (task.client && task.client.toString() !== req.user.id)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    task.attemptCount = (task.attemptCount || 0) + 1;
    task.submission = null;
    task.clientCanViewSubmission = false; 

    if (task.attemptCount >= task.maxAttempts) {
      task.status = 'declined';
    } else {
      task.status = 'assigned'; 
    }

    await task.save();
    return res.json({ message: 'Revision requested', task });
  } catch (err) {
    return res.status(500).json({ message: 'Request failed' });
  }
};

/**
 * ===============================
 * GET STUDENT TASKS
 * ===============================
 */
exports.getStudentTasks = async (req, res) => {
  try {
    const tasks = await Task.find({
      student: req.user.id,
      status: { $in: ['assigned', 'under_review', 'completed', 'declined'] },
    }).sort({ updatedAt: -1 });
    return res.json(tasks);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to load workspace' });
  }
};

/**
 * ===============================
 * GET CLIENT TASKS
 * ===============================
 */
exports.getClientTasks = async (req, res) => {
    try {
      const tasks = await Task.find({
        client: req.user.id,
      }).sort({ createdAt: -1 });
      return res.json(tasks);
    } catch (err) {
      return res.status(500).json({ message: 'Failed to fetch tasks' });
    }
  };