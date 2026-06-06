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
      budget, // Optional
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
      budget: asNumber(budget), // Can be null
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
 * ===============================
 * GET ALL TASKS (Admin/Client Feed)
 * ===============================
 */
exports.getAllTasks = async (req, res) => {
  try {
    const { clientId, domain } = req.query;
    const query = {};

    if (clientId) {
      query.client = clientId;
    } else {
      query.status = 'open';
    }

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
    const task = await Task.findById(req.params.taskId);

    if (!task || task.student?.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized submission' });
    }

    // Update Task
    task.submission = {
      student: req.user.id,
      fileUrl: String(fileUrl || '').trim(),
      notes: String(notes || '').trim(),
      approved: false,
      submittedAt: new Date(),
    };

    task.status = 'under_review';
    
    // Logic: Submission is hidden from client until Admin grants permission
    task.clientCanViewSubmission = false; 

    await task.save();

    return res.json({ message: 'Work submitted to Admin for review', task });
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
    const task = await Task.findById(req.params.taskId);

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

    // Increment student reputation
    const student = await User.findById(task.student);
    if (student) {
      student.tasksCompleted = (student.tasksCompleted || 0) + 1;
      await student.save();
    }

    return res.json({ 
      message: 'Work approved. Direct payment details (QR) are now visible.', 
      task 
    });
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
    const task = await Task.findById(req.params.taskId);

    if (!task || (task.client && task.client.toString() !== req.user.id)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    task.attemptCount = (task.attemptCount || 0) + 1;
    task.submission = null;
    task.clientCanViewSubmission = false; // Hide until next submission

    if (task.attemptCount >= task.maxAttempts) {
      task.status = 'declined';
    } else {
      task.status = 'assigned'; // Back to work
    }

    await task.save();

    return res.json({ message: 'Revision requested', task });
  } catch (err) {
    return res.status(500).json({ message: 'Request failed' });
  }
};

/**
 * ===============================
 * GET STUDENT TASKS (Workspace)
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