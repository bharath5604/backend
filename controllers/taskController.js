// backend/controllers/taskController.js
const Task = require('../models/Task');
const User = require('../models/User');

// Helper for numeric parsing
const asNumber = (val) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

/**
 * Global Real-time Broadcast Helper
 * Signals the frontend to refresh specific UI components
 */
const emitUpdate = (req, room, event, data) => {
  const io = req.app.get('socketio');
  if (io) {
    io.to(room).emit(event, data);
    // Signal admin dashboard to refresh counters (Total Tasks, Open Tasks, etc)
    io.emit('admin_stats_update', { timestamp: new Date() });
  }
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

    // DYNAMIC EMIT: Update Admin's "Task Registry" and Dashboard live
    emitUpdate(req, 'admin_room', 'task_created', { taskId: task._id });

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

    // DYNAMIC EMIT: Alert Admin that an Emergency Post needs matching
    emitUpdate(req, 'admin_room', 'emergency_task_created', { taskId: task._id });

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
 * ==========================================
 */
exports.rateStudent = async (req, res) => {
  try {
    const scoreValue = Number(req.body.score);
    const feedbackText = req.body.text || req.body.feedback || '';

    if (isNaN(scoreValue)) {
      return res.status(400).json({ message: "Invalid score. Must be a number." });
    }

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (!task.student) return res.status(400).json({ message: 'No student assigned' });

    task.score = scoreValue;
    task.rating = scoreValue;
    task.feedback = feedbackText;
    await task.save();

    const student = await User.findById(task.student);
    const client = await User.findById(req.user.id);

    if (student) {
      student.totalScore = (student.totalScore || 0) + scoreValue;
      student.totalScoreCount = (student.totalScoreCount || 0) + 1;

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

      // DYNAMIC EMIT: Update student's dashboard and wallet immediately
      emitUpdate(req, student._id.toString(), 'feedback_update', { score: scoreValue });
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
    task.clientCanViewSubmission = true; 
    task.clientCanDownload = false;  // Gate is locked by default

    await task.save();

    // DYNAMIC EMIT: Signal the Client and Admin that work is ready for review
    emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id, status: 'under_review' });

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

    const student = await User.findById(task.student);
    if (student) {
      student.tasksCompleted = (student.tasksCompleted || 0) + 1;
      await student.save();
      
      // DYNAMIC EMIT: Signal the Student that their work is approved (triggers success UI)
      emitUpdate(req, student._id.toString(), 'task_approved', { taskId: task._id });
    }

    // Update global task room (triggers QR visibility in Client app)
    emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id, status: 'completed' });

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

    // DYNAMIC EMIT: Tell the student they need to modify their work immediately
    if (task.student) {
      emitUpdate(req, task.student.toString(), 'task_status_changed', { taskId: task._id, status: task.status });
    }
    emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id });

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