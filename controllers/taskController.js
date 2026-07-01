// backend/controllers/taskController.js
const Task = require('../models/Task');
const User = require('../models/User');
const Message = require('../models/Message'); // IMPORTED for automated system messages
const { sendNotification } = require('../utils/fcm');

// Helper for numeric parsing
const asNumber = (val) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

/**
 * Global Normalization Helper
 * Standardizes Title Case for domains and skills (Fixes "edting" / "EDITING" issues)
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
 * Signals the frontend to refresh specific UI components instantly
 */
const emitUpdate = (req, room, event, data) => {
  const io = req.app.get('socketio');
  if (io) {
    // 1. Update the specific task or user room
    io.to(room).emit(event, data);
    // 2. Refresh counters on all Admin Dashboards globally
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

    // MODIFICATION: 'budget' removed from destructuring as it's no longer sent from frontend
    const {
      title, description, deadline, location,
      domain, company, requiredSkills, attachments, attachmentNames,
    } = req.body;

    if (!title || !description || !deadline) {
      return res.status(400).json({ message: 'Missing required project details' });
    }

    const cleanDomain = normalizeString(domain || 'General');
    const cleanSkills = (requiredSkills || []).map(s => normalizeString(s)).filter(s => s.length > 0);

    const task = await Task.create({
      title: title.trim(),
      description: description.trim(),
      budget: null, // MODIFICATION: Explicitly set to null. Admin will finalize this later.
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

    emitUpdate(req, 'admin_room', 'task_created', { taskId: task._id });

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
    // MODIFICATION: 'budget' removed from destructuring
    const {
      title, description, guestName, guestMobile, guestEmail,
      deadline, domain, requiredSkills
    } = req.body;

    if (!title || !description || !guestName || !guestMobile || !deadline) {
      return res.status(400).json({ message: 'Missing required guest fields' });
    }

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
      budget: null, // MODIFICATION: Initialized as null for Emergency Posts
      deadline: new Date(deadline),
      domain: cleanDomain,
      requiredSkills: cleanSkills,
      status: 'open'
    });

    emitUpdate(req, 'admin_room', 'emergency_task_created', { taskId: task._id });

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

    const task = await Task.findById(req.params.id || req.params.taskId);
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
        taskId: task._id, taskTitle: task.title, clientId: req.user.id,
        clientName: client?.name || "Client", rating: scoreValue,
        comment: feedbackText, domain: task.domain, createdAt: new Date()
      });
      await student.save();
      emitUpdate(req, student._id.toString(), 'feedback_update', { score: scoreValue });
      await sendNotification(student._id.toString(), {
          title: "New Task Review",
          body: `You received a ${scoreValue}-star rating for ${task.title}.`,
          data: { type: "payment_received" }
      });
    }
    return res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
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
      return res.status(403).json({ message: 'Unauthorized' });
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
    task.modificationNotes = ''; 

    await task.save();

    emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id });

    const admin = await User.findOne({ role: 'admin' });
    if (admin) {
        await sendNotification(admin._id.toString(), {
            title: "Work Submitted",
            body: `Student delivered work for: ${task.title}. Review required.`,
            data: { type: "task_submitted", taskId: task._id.toString() }
        });
    }

    return res.json({ message: 'Work submitted for review', task });
  } catch (err) { return res.status(500).json({ message: 'Submission failed' }); }
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
      emitUpdate(req, student._id.toString(), 'task_approved', { taskId: task._id });
      await sendNotification(student._id.toString(), {
          title: "Work Approved!",
          body: `Client finalized your project: ${task.title}.`,
          data: { type: "task_assigned" }
      });
    }

    emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id });
    return res.json({ message: 'Work approved.', task });
  } catch (err) { return res.status(500).json({ message: 'Approval failed' }); }
};

/**
 * ===============================
 * CLIENT DECLINE / MODIFY (REVISION)
 * ===============================
 */
exports.declineWork = async (req, res) => {
  try {
    const { reason } = req.body; 
    const task = await Task.findById(req.params.taskId || req.params.id);
    
    if (!task || (task.client && task.client.toString() !== req.user.id)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    task.attemptCount = (task.attemptCount || 0) + 1;
    task.submission = null; 
    task.status = 'assigned'; 

    task.modificationNotes = String(reason || '').trim();

    await task.save();

    const admin = await User.findOne({ role: 'admin' });

    if (admin) {
        await Message.create({
            task: task._id, sender: admin._id, receiver: task.student, 
            student: task.student, 
            text: `⚠️ MODIFICATION REQUESTED BY CLIENT:\n"${reason}"\n\nPlease update and resubmit the work.`
        });

        await Message.create({
            task: task._id, sender: admin._id, receiver: task.client,
            student: null, 
            text: `✅ You requested these modifications:\n"${reason}"\n\nThe student has been notified.`
        });
    }

    if (task.student) {
      emitUpdate(req, task.student.toString(), 'task_status_changed', { taskId: task._id, status: 'assigned' });
      await sendNotification(task.student.toString(), {
          title: "Revision Required",
          body: `Client requested modifications for ${task.title}.`,
          data: { type: "task_declined", taskId: task._id.toString() }
      });
    }
    emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id });
    emitUpdate(req, task._id.toString(), 'new_message', { taskId: task._id });

    return res.json({ message: 'Revision requested', task });
  } catch (err) { return res.status(500).json({ message: 'Request failed' }); }
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
      .populate('student', 'name email mobile skills tasksCompleted bankAccountHolderName bankAccountNumber ifscCode totalScore totalScoreCount');
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