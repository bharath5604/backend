const Task = require('../models/Task');
const User = require('../models/User');
const Payment = require('../models/Payment');

const asNumber = (val) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
};

/**
 * ===============================
 * CREATE TASK (Client only)
 * ===============================
 */
exports.createTask = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'client') {
      return res.status(403).json({
        message: 'Only clients can create tasks',
      });
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

    const cleanTitle = String(title || '').trim();
    const cleanDescription = String(description || '').trim();
    const cleanBudget = asNumber(budget);
    const cleanDeadline = deadline ? new Date(deadline) : null;

    if (!cleanTitle || !cleanDescription || !budget || !deadline) {
      return res.status(400).json({
        message: 'Please fill required fields',
      });
    }

    if (Number.isNaN(cleanDeadline?.getTime())) {
      return res.status(400).json({
        message: 'Invalid deadline',
      });
    }

    const task = await Task.create({
      title: cleanTitle,
      description: cleanDescription,
      budget: cleanBudget,
      deadline: cleanDeadline,
      location: String(location || '').trim(),
      domain: String(domain || '').trim(),
      company: String(company || '').trim(),
      requiredSkills: Array.isArray(requiredSkills)
        ? requiredSkills
            .map((s) => String(s || '').trim())
            .filter(Boolean)
        : [],
      attachments: Array.isArray(attachments) ? attachments : [],
      attachmentNames: Array.isArray(attachmentNames) ? attachmentNames : [],
      client: req.user.id,
      status: 'open',
      attemptCount: 0,
      // student, assignedByAdmin, assignedAt will remain null for open
    });

    return res.status(201).json({
      message: 'Task created successfully',
      task,
    });
  } catch (err) {
    console.error('Create Task Error:', err);

    return res.status(500).json({
      message: 'Failed to create task',
      error: err.message,
    });
  }
};

/**
 * ===============================
 * GET ALL TASKS (feed + client filter)
 * ===============================
 */
exports.getAllTasks = async (req, res) => {
  try {
    const { clientId, domain, minBudget, maxBudget } = req.query;

    const query = {};

    if (clientId) {
      query.client = clientId;
    } else {
      query.status = 'open';
    }

    if (domain) {
      query.domain = String(domain).trim();
    }
    if (minBudget) {
      query.budget = {
        ...(query.budget || {}),
        $gte: asNumber(minBudget),
      };
    }
    if (maxBudget) {
      query.budget = {
        ...(query.budget || {}),
        $lte: asNumber(maxBudget),
      };
    }

    const tasks = await Task.find(query)
      .populate('client', 'name email company')
      .sort({ createdAt: -1 });

    return res.json(tasks);
  } catch (err) {
    console.error('Get Tasks Error:', err);

    return res.status(500).json({
      message: 'Failed to fetch tasks',
      error: err.message,
    });
  }
};

/**
 * ===============================
 * GET TASK BY ID
 * ===============================
 */
exports.getTaskById = async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await Task.findById(taskId)
      .populate('client', 'name email company')
      .populate('student', 'name email');

    if (!task) {
      return res.status(404).json({
        message: 'Task not found',
      });
    }

    return res.json(task);
  } catch (err) {
    console.error('Get Task Error:', err);

    return res.status(500).json({
      message: 'Failed to fetch task',
      error: err.message,
    });
  }
};

/**
 * ===============================
 * ASSIGN TASK TO STUDENT
 * (client assigns, but schema requires assignedByAdmin)
 * ===============================
 */
exports.assignTask = async (req, res) => {
  try {
    const { studentId } = req.body;
    const { taskId } = req.params;

    if (!studentId) {
      return res.status(400).json({ message: 'studentId is required' });
    }

    const task = await Task.findById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Only client who owns the task can assign
    if (!req.user || req.user.id !== task.client.toString()) {
      return res.status(403).json({
        message: 'Only client can assign',
      });
    }

    if (task.status !== 'open' && task.status !== 'assigned') {
      return res.status(400).json({
        message: 'Task cannot be assigned in its current status',
      });
    }

    task.student = studentId;
    task.status = 'assigned';
    task.attemptCount = 0;

    // For now, treat the client as the "assigner" to satisfy schema
    task.assignedByAdmin = req.user.id;
    task.assignedAt = task.assignedAt || new Date();

    await task.save();

    return res.json({
      message: 'Task assigned successfully',
      task,
    });
  } catch (err) {
    console.error('Assign Task Error:', err);

    return res.status(500).json({
      message: 'Assign failed',
      error: err.message,
    });
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
    const { taskId } = req.params;

    const task = await Task.findById(taskId);

    if (!task) {
      return res.status(404).json({
        message: 'Task not found',
      });
    }

    if (!task.student || task.student.toString() !== req.user.id) {
      return res.status(403).json({
        message: 'Not your task',
      });
    }

    if (
      task.attemptCount >= (task.maxAttempts || 3) ||
      task.status === 'completed' ||
      task.status === 'declined'
    ) {
      return res.status(400).json({
        message: 'No more submissions allowed for this task',
      });
    }

    task.submission = {
      student: req.user.id,
      fileUrl: String(fileUrl || '').trim(),
      notes: String(notes || '').trim(),
      approved: false,
      submittedAt: new Date(),
    };

    task.status = 'under_review';

    // Ensure schema constraints: for non-open status, both must exist
    if (!task.assignedByAdmin) {
      // Fallback: keep previous value if existed, else set to client as assigner
      task.assignedByAdmin = task.assignedByAdmin || task.client;
    }
    if (!task.assignedAt) {
      task.assignedAt = new Date();
    }

    await task.save();

    return res.json({
      message: 'Work submitted',
      task,
    });
  } catch (err) {
    console.error('Submit Work Error:', err);

    return res.status(500).json({
      message: 'Submission failed',
      error: err.message,
    });
  }
};

/**
 * ===============================
 * CLIENT APPROVE WORK
 * ===============================
 */
exports.approveWork = async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await Task.findById(taskId);

    if (!task) {
      return res.status(404).json({
        message: 'Task not found',
      });
    }

    if (!req.user || req.user.id !== task.client.toString()) {
      return res.status(403).json({
        message: 'Not authorized',
      });
    }

    if (!task.submission) {
      return res.status(400).json({
        message: 'No submission',
      });
    }

    task.submission.approved = true;
    task.status = 'completed';

    // Ensure constraints for non-open status
    if (!task.student) {
      task.student = task.submission.student;
    }
    if (!task.assignedByAdmin) {
      task.assignedByAdmin = task.assignedByAdmin || task.client;
    }
    if (!task.assignedAt) {
      task.assignedAt = new Date();
    }

    await task.save();

    const student = await User.findById(task.submission.student);

    if (student) {
      const budget = asNumber(task.budget);
      student.wallet = (asNumber(student.wallet) || 0) + budget;
      student.tasksCompleted = (student.tasksCompleted || 0) + 1;

      await student.save();
    }

    return res.json({
      message: 'Task approved',
      task,
      wallet: student?.wallet,
    });
  } catch (err) {
    console.error('Approve Work Error:', err);

    return res.status(500).json({
      message: 'Approval failed',
      error: err.message,
    });
  }
};

/**
 * ===============================
 * CLIENT DECLINE WORK (3‑attempt logic)
 * ===============================
 */
exports.declineWork = async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await Task.findById(taskId);

    if (!task) {
      return res.status(404).json({
        message: 'Task not found',
      });
    }

    if (!req.user || req.user.id !== task.client.toString()) {
      return res.status(403).json({
        message: 'Not authorized',
      });
    }

    if (!task.submission) {
      return res.status(400).json({
        message: 'No submission to decline',
      });
    }

    const maxAttempts = task.maxAttempts || 3;

    task.attemptCount = (task.attemptCount || 0) + 1;
    task.submission = null;

    if (task.attemptCount >= maxAttempts) {
      task.status = 'declined';

      await Payment.updateMany(
        {
          task: task._id,
          status: { $in: ['created', 'held', 'approved'] },
        },
        {
          $set: {
            status: 'declined',
            declineReason: 'Max attempts reached',
          },
        },
      );
    } else {
      task.status = 'assigned';
    }

    // Ensure constraints for non-open status
    if (['assigned', 'under_review', 'completed', 'declined'].includes(task.status)) {
      if (!task.student) {
        // In this flow, student must exist; if not, we keep it as-is to trigger schema error
        task.student = task.student;
      }
      if (!task.assignedByAdmin) {
        task.assignedByAdmin = task.assignedByAdmin || task.client;
      }
      if (!task.assignedAt) {
        task.assignedAt = new Date();
      }
    }

    await task.save();

    return res.json({
      message:
        task.status === 'declined'
          ? 'Task declined, no more attempts allowed'
          : 'Submission declined, student can resubmit',
      task,
    });
  } catch (err) {
    console.error('Decline Work Error:', err);

    return res.status(500).json({
      message: 'Decline failed',
      error: err.message,
    });
  }
};

/**
 * ===============================
 * RATE STUDENT
 * ===============================
 */
exports.rateStudent = async (req, res) => {
  try {
    const { rating, feedback } = req.body;
    const { taskId } = req.params;

    const task = await Task.findById(taskId);

    if (!task) {
      return res.status(404).json({
        message: 'Task not found',
      });
    }

    if (!req.user || req.user.id !== task.client.toString()) {
      return res.status(403).json({
        message: 'Not authorized',
      });
    }

    task.rating = rating;
    task.feedback = feedback;

    await task.save();

    return res.json({
      message: 'Rating submitted',
      task,
    });
  } catch (err) {
    console.error('Rating Error:', err);

    return res.status(500).json({
      message: 'Rating failed',
      error: err.message,
    });
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
    }).sort({ createdAt: -1 });

    return res.json(tasks);
  } catch (err) {
    console.error('Get Student Tasks Error:', err);

    return res.status(500).json({
      message: 'Failed',
      error: err.message,
    });
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
    console.error('Get Client Tasks Error:', err);

    return res.status(500).json({
      message: 'Failed',
      error: err.message,
    });
  }
};