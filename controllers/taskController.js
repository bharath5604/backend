const Task = require("../models/Task");
const User = require("../models/User");
const Payment = require("../models/Payment");

/**
 * ===============================
 * CREATE TASK (Client only)
 * ===============================
 */
exports.createTask = async (req, res) => {
  try {
    if (!req.user || req.user.role !== "client") {
      return res.status(403).json({
        message: "Only clients can create tasks",
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

    if (!title || !description || !budget || !deadline) {
      return res.status(400).json({
        message: "Please fill required fields",
      });
    }

    const task = new Task({
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
      client: req.user.id,
      status: "open",
      attemptCount: 0,
      // maxAttempts uses default = 3 from schema
    });

    await task.save();

    res.status(201).json({
      message: "Task created successfully",
      task,
    });
  } catch (err) {
    console.error("Create Task Error:", err);

    res.status(500).json({
      message: "Failed to create task",
      error: err.message,
    });
  }
};

/**
 * ===============================
 * GET ALL TASKS (feed + client filter)
 * ===============================
 * - When clientId is NOT provided: only open tasks (public feed)
 * - When clientId IS provided: return ALL tasks of that client (any status)
 */
exports.getAllTasks = async (req, res) => {
  try {
    const { clientId, domain, minBudget, maxBudget } = req.query;

    const query = {};

    if (clientId) {
      // For client profile: show all tasks of this client, not just open
      query.client = clientId;
    } else {
      // Public feed: only open tasks
      query.status = "open";
    }

    if (domain) {
      query.domain = domain;
    }
    if (minBudget) {
      query.budget = { ...(query.budget || {}), $gte: Number(minBudget) };
    }
    if (maxBudget) {
      query.budget = { ...(query.budget || {}), $lte: Number(maxBudget) };
    }

    const tasks = await Task.find(query)
      .populate("client", "name email company")
      .sort({ createdAt: -1 });

    res.json(tasks);
  } catch (err) {
    console.error("Get Tasks Error:", err);

    res.status(500).json({
      message: "Failed to fetch tasks",
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
    const task = await Task.findById(req.params.taskId)
      .populate("client", "name email company")
      .populate("student", "name email");

    if (!task) {
      return res.status(404).json({
        message: "Task not found",
      });
    }

    res.json(task);
  } catch (err) {
    console.error("Get Task Error:", err);

    res.status(500).json({
      message: "Failed to fetch task",
      error: err.message,
    });
  }
};

/**
 * ===============================
 * ASSIGN TASK TO STUDENT
 * ===============================
 * Used when client finally selects one student.
 */
exports.assignTask = async (req, res) => {
  try {
    const { studentId } = req.body;

    const task = await Task.findById(req.params.taskId);

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (req.user.id !== task.client.toString()) {
      return res.status(403).json({
        message: "Only client can assign",
      });
    }

    task.student = studentId;
    task.status = "assigned";
    // reset attempts whenever a task is (re)assigned
    task.attemptCount = 0;

    await task.save();

    res.json({
      message: "Task assigned successfully",
      task,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Assign failed",
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

    const task = await Task.findById(req.params.taskId);

    if (!task) {
      return res.status(404).json({
        message: "Task not found",
      });
    }

    if (!task.student || task.student.toString() !== req.user.id) {
      return res.status(403).json({
        message: "Not your task",
      });
    }

    // Block submission if max attempts already reached or task closed
    if (
      task.attemptCount >= (task.maxAttempts || 3) ||
      task.status === "completed" ||
      task.status === "declined"
    ) {
      return res.status(400).json({
        message: "No more submissions allowed for this task",
      });
    }

    task.submission = {
      student: req.user.id,
      fileUrl,
      notes,
      approved: false,
      submittedAt: new Date(),
    };

    task.status = "under_review";

    await task.save();

    res.json({
      message: "Work submitted",
      task,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Submission failed",
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
    const task = await Task.findById(req.params.taskId);

    if (!task) {
      return res.status(404).json({
        message: "Task not found",
      });
    }

    if (req.user.id !== task.client.toString()) {
      return res.status(403).json({
        message: "Not authorized",
      });
    }

    if (!task.submission) {
      return res.status(400).json({
        message: "No submission",
      });
    }

    // Mark submission approved and close task
    task.submission.approved = true;
    task.status = "completed";

    await task.save();

    /**
     * PAY STUDENT (legacy wallet credit)
     * You also have Payment model + admin release flow for actual payouts.
     */
    const student = await User.findById(task.submission.student);

    if (student) {
      student.wallet = (student.wallet || 0) + task.budget;
      student.tasksCompleted = (student.tasksCompleted || 0) + 1;

      await student.save();
    }

    res.json({
      message: "Task approved",
      task,
      wallet: student?.wallet,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Approval failed",
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
    const task = await Task.findById(req.params.taskId);

    if (!task) {
      return res.status(404).json({
        message: "Task not found",
      });
    }

    if (req.user.id !== task.client.toString()) {
      return res.status(403).json({
        message: "Not authorized",
      });
    }

    if (!task.submission) {
      return res.status(400).json({
        message: "No submission to decline",
      });
    }

    const maxAttempts = task.maxAttempts || 3;

    // Increase attempt count
    task.attemptCount = (task.attemptCount || 0) + 1;

    // Clear submission when declined so student can resubmit
    task.submission = null;

    if (task.attemptCount >= maxAttempts) {
      // Hard decline: no more submissions or messages
      task.status = "declined";

      // Cancel any non‑released payments for this task
      await Payment.updateMany(
        {
          task: task._id,
          status: { $in: ["created", "held", "approved"] },
        },
        {
          $set: {
            status: "declined",
            declineReason: "Max attempts reached",
          },
        }
      );
    } else {
      // Allow student to try again with same task
      task.status = "assigned";
    }

    await task.save();

    res.json({
      message:
        task.status === "declined"
          ? "Task declined, no more attempts allowed"
          : "Submission declined, student can resubmit",
      task,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Decline failed",
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

    const task = await Task.findById(req.params.taskId);

    if (!task) {
      return res.status(404).json({
        message: "Task not found",
      });
    }

    if (req.user.id !== task.client.toString()) {
      return res.status(403).json({
        message: "Not authorized",
      });
    }

    task.rating = rating;
    task.feedback = feedback;

    await task.save();

    res.json({
      message: "Rating submitted",
      task,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Rating failed",
      error: err.message,
    });
  }
};

/**
 * ===============================
 * GET STUDENT TASKS (Workspace)
 * ===============================
 * Only return tasks that are actually assigned to this student.
 */
exports.getStudentTasks = async (req, res) => {
  try {
    const tasks = await Task.find({
      student: req.user.id,
      status: { $in: ["assigned", "under_review", "completed", "declined"] },
    }).sort({ createdAt: -1 });

    res.json(tasks);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed",
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

    res.json(tasks);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed",
      error: err.message,
    });
  }
};