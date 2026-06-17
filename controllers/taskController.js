// backend/controllers/taskController.js
const Task = require('../models/Task');
const User = require('../models/User');
const { sendNotification } = require('../utils/fcm');

// Helper for numeric parsing
const asNumber = (val) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

/**
 * Global Normalization Helper
 * Converts strings to Title Case and trims whitespace
 * e.g. " web dev " -> "Web Dev"
 */
function normalizeString(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .trim()
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Global Real-time Broadcast Helper
 */
const emitUpdate = (req, room, event, data) => {
  const io = req.app.get('socketio');
  if (io) {
    io.to(room).emit(event, data);
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

    // NORMALIZATION: Clean the domain and skills before saving
    const cleanDomain = normalizeString(domain || 'General');
    const cleanSkills = (requiredSkills || []).map(s => normalizeString(s)).filter(s => s.length > 0);

    const task = await Task.create({
      title: title.trim(),
      description: description.trim(),
      budget: asNumber(budget), 
      deadline: new Date(deadline),
      location: String(location || '').trim(),
      domain: cleanDomain,
      company: String(company || '').trim(),
      requiredSkills: cleanSkills,
      attachments: Array.isArray(attachments) ? attachments : [],
      attachmentNames: Array.isArray(attachmentNames) ? attachmentNames : [],
      client: req.user.id,
      isGuestTask: false,
      status: 'open'
    });

    // REAL-TIME: Update Admin Registry
    emitUpdate(req, 'admin_room', 'task_created', { taskId: task._id });

    // PUSH NOTIFICATION: Alert Admin
    const admin = await User.findOne({ role: 'admin' });
    if (admin) {
        await sendNotification(admin._id.toString(), {
            title: "New Project Posted",
            body: `${req.user.name} requires ${cleanDomain} help.`,
            data: { type: "task_update", taskId: task._id.toString() }
        });
    }

    return res.status(201).json({ message: 'Task created successfully', task });
  } catch (err) {
    console.error('Create Task Error:', err);
    return res.status(500).json({ message: 'Failed to create task' });
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

    // NORMALIZATION: Clean input for better Admin matching
    const cleanDomain = normalizeString(domain || 'General');
    const cleanSkills = (requiredSkills || []).map(s => normalizeString(s)).filter(s => s.length > 0);

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
      domain: cleanDomain,
      requiredSkills: cleanSkills,
      status: 'open'
    });

    // REAL-TIME: Alert Admin Dashboard
    emitUpdate(req, 'admin_room', 'emergency_task_created', { taskId: task._id });

    // PUSH NOTIFICATION: Alert Admin
    const admin = await User.findOne({ role: 'admin' });
    if (admin) {
        await sendNotification(admin._id.toString(), {
            title: "🚨 Emergency Task",
            body: `Guest ${guestName} needs ${cleanDomain} matching.`,
            data: { type: "task_update", taskId: task._id.toString() }
        });
    }

    return res.status(201).json({
      message: 'Emergency task submitted. Admin will contact you shortly.',
      task
    });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to submit guest task' });
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
        domain: task.domain,
        createdAt: new Date()
      });

      await student.save();

      // REAL-TIME: Update Student Stats
      emitUpdate(req, student._id.toString(), 'feedback_update', { score: scoreValue });

      // PUSH NOTIFICATION: Notify Student
      await sendNotification(student._id.toString(), {
          title: "New Task Review",
          body: `You received a ${scoreValue}-star rating for ${task.title}.`,
          data: { type: "payment_received" }
      });
    }
    return res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
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
    task.clientCanDownload = false;  

    await task.save();

    // REAL-TIME: Update Task Room (Admin & Client)
    emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id });

    // PUSH NOTIFICATION: Alert Admin
    const admin = await User.findOne({ role: 'admin' });
    if (admin) {
        await sendNotification(admin._id.toString(), {
            title: "Submission Received",
            body: `Deliverables uploaded for: ${task.title}`,
            data: { type: "task_submitted", taskId: task._id.toString() }
        });
    }

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

    task.submission.approved = true;
    task.submission.clientApprovedAt = new Date();
    task.status = 'completed';

    await task.save();

    const student = await User.findById(task.student);
    if (student) {
      student.tasksCompleted = (student.tasksCompleted || 0) + 1;
      await student.save();
      
      // REAL-TIME: Update Student Dashboard
      emitUpdate(req, student._id.toString(), 'task_approved', { taskId: task._id });

      // PUSH NOTIFICATION: Congratulate Student
      await sendNotification(student._id.toString(), {
          title: "Work Approved!",
          body: `Client finalized your project: ${task.title}. Payout initiated.`,
          data: { type: "task_assigned" }
      });
    }

    emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id });

    return res.json({ message: 'Work approved.', task });
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

    // REAL-TIME & PUSH: Inform student of modification request
    if (task.student) {
      emitUpdate(req, task.student.toString(), 'task_status_changed', { taskId: task._id, status: task.status });
      await sendNotification(task.student.toString(), {
          title: "Revision Required",
          body: `Client requested changes for ${task.title}. Check chat.`,
          data: { type: "task_declined", taskId: task._id.toString() }
      });
    }
    emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id });

    return res.json({ message: 'Revision requested', task });
  } catch (err) {
    return res.status(500).json({ message: 'Request failed' });
  }
};

/**
 * ===============================
 * DATA RETRIEVAL
 * ===============================
 */

exports.getAllTasks = async (req, res) => {
  try {
    const { clientId, domain } = req.query;
    const query = {};
    if (clientId) query.client = clientId;
    else query.status = 'open';
    if (domain) query.domain = normalizeString(domain);

    const tasks = await Task.find(query).populate('client', 'name email company').sort({ createdAt: -1 });
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Fetch failed' }); }
};

exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId || req.params.id)
      .populate('client', 'name email company mobile')
      .populate('student', 'name email mobile skills tasksCompleted bankAccountHolderName bankAccountNumber ifscCode');
    if (!task) return res.status(404).json({ message: 'Task not found' });
    return res.json(task);
  } catch (err) { return res.status(500).json({ message: 'Error fetching task' }); }
};

exports.getStudentTasks = async (req, res) => {
  try {
    const tasks = await Task.find({
      student: req.user.id,
      status: { $in: ['assigned', 'under_review', 'completed', 'declined'] },
    }).sort({ updatedAt: -1 });
    return res.json(tasks);
  } catch (err) { return res.status(500).json({ message: 'Load failed' }); }
};

exports.getClientTasks = async (req, res) => {
    try {
      const tasks = await Task.find({ client: req.user.id }).sort({ createdAt: -1 });
      return res.json(tasks);
    } catch (err) { return res.status(500).json({ message: 'Fetch failed' }); }
};