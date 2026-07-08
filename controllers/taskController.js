// backend/controllers/taskController.js
const Task = require('../models/Task');
const User = require('../models/User');
const Message = require('../models/Message'); 
const { sendNotification } = require('../utils/fcm'); // Now includes Socket + DB logic

// Helper for numeric parsing
const asNumber = (val) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

/**
 * Global Normalization Helper
 * Standardizes Title Case for domains and skills
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
 * room: specific sub-room or userId
 */
const emitUpdate = (req, room, event, data) => {
  const io = req.app.get('socketio');
  if (io) {
    io.to(room).emit(event, data);
    // Refresh counters on all Admin Dashboards globally
    io.emit('admin_stats_update', { timestamp: new Date() });
  }
};

/**
 * CREATE TASK (Registered Client)
 */
exports.createTask = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'client') {
      return res.status(403).json({ message: 'Only clients can create tasks' });
    }

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
      budget: null, // Admin finalizes this during negotiation
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

    // Notify Admin via the new MongoDB + Socket channel
    const admin = await User.findOne({ role: 'admin' });
    if (admin) {
        await sendNotification(admin._id.toString(), {
            title: "New Task Posted",
            body: `A client posted a new requirement: ${task.title}`,
            data: { type: "task_update", taskId: task._id.toString() }
        }, req);
    }

    return res.status(201).json({ message: 'Task created successfully', task });
  } catch (err) {
    console.error('Create Task Error:', err);
    return res.status(500).json({ message: 'Failed to create task' });
  }
};

/**
 * CREATE GUEST TASK (Emergency Lead)
 */
exports.createGuestTask = async (req, res) => {
  try {
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
      budget: null, 
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
 * RATE STUDENT & UPDATE REPUTATION
 */
exports.rateStudent = async (req, res) => {
  try {
    const scoreValue = Number(req.body.score);
    const feedbackText = req.body.feedback || req.body.text || '';

    const task = await Task.findById(req.params.id || req.params.taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

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
      
      // Update local wallet and feedback stats in real-time
      emitUpdate(req, student._id.toString(), 'feedback_update', { score: scoreValue });

      // Notify Student via DB + Sockets + FCM
      await sendNotification(student._id.toString(), {
          title: "New Project Review",
          body: `You received a ${scoreValue}-star rating for ${task.title}.`,
          data: { type: "payment_received", taskId: task._id.toString() }
      }, req);
    }
    return res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

/**
 * STUDENT SUBMIT WORK
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
    task.modificationNotes = ''; // Clear notes as they've been addressed

    await task.save();

    // Signal thread sub-rooms
    emitUpdate(req, `${task._id}_client`, 'task_update', { taskId: task._id });
    emitUpdate(req, 'admin_room', 'task_update', { taskId: task._id });

    // Notify Admin via DB + Sockets
    const admin = await User.findOne({ role: 'admin' });
    if (admin) {
        await sendNotification(admin._id.toString(), {
            title: "Work Submitted",
            body: `Student delivered work for: ${task.title}. Review required.`,
            data: { type: "task_submitted", taskId: task._id.toString() }
        }, req);
    }

    return res.json({ message: 'Work submitted for review', task });
  } catch (err) { return res.status(500).json({ message: 'Submission failed' }); }
};

/**
 * CLIENT APPROVE WORK
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
      
      // Notify Student via DB + Sockets
      await sendNotification(student._id.toString(), {
          title: "Deliverables Approved!",
          body: `Client finalized your project: ${task.title}.`,
          data: { type: "task_assigned", taskId: task._id.toString() }
      }, req);
    }

    // Refresh UI for all relevant isolated threads
    emitUpdate(req, `${task._id}_client`, 'task_update', { taskId: task._id });
    emitUpdate(req, 'admin_room', 'task_update', { taskId: task._id });

    return res.json({ message: 'Work approved.', task });
  } catch (err) { return res.status(500).json({ message: 'Approval failed' }); }
};

/**
 * CLIENT DECLINE / MODIFY (REVISION - NO LIMIT)
 * Logic: Saves modificationNotes to DB and notifies the student thread.
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
    task.status = 'assigned'; // Loop back to active work
    task.modificationNotes = String(reason || '').trim();

    await task.save();

    const admin = await User.findOne({ role: 'admin' });
    if (admin) {
        // Log modification context into both isolated threads automatically
        await Message.create({
            task: task._id, sender: admin._id, receiver: task.student, 
            student: task.student, 
            text: `⚠️ MODIFICATION REQUESTED BY CLIENT:\n"${reason}"`
        });
        await Message.create({
            task: task._id, sender: admin._id, receiver: task.client,
            student: null, 
            text: `✅ You requested these modifications:\n"${reason}"`
        });
    }

    if (task.student) {
      // Refresh the specific student thread (shows orange instruction box)
      emitUpdate(req, `${task._id}_student_${task.student}`, 'task_update', { taskId: task._id });
      
      // Notify Student via DB + Sockets
      await sendNotification(task.student.toString(), {
          title: "Revision Required",
          body: `Client requested changes for: ${task.title}.`,
          data: { type: "task_declined", taskId: task._id.toString() }
      }, req);
    }
    
    emitUpdate(req, `${task._id}_client`, 'task_update', { taskId: task._id });

    return res.json({ message: 'Revision requested', task });
  } catch (err) { return res.status(500).json({ message: 'Request failed' }); }
};

/**
 * DATA RETRIEVAL
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
