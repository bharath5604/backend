const Task = require("../models/Task");
const User = require("../models/User");

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
      // maxAttempts will use default = 3 from schema
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
 * GET ALL OPEN TASKS
 * ===============================
 */
exports.getAllTasks = async (req, res) => {
  try {
    const tasks = await Task.find({ status: "open" })
      .populate("client", "name email")
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
      .populate("client", "name email")
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
 */
exports.assignTask = async (req, res) => {
  try {
    const { studentId } = req.body;

    const task = await Task.findById(req.params.taskId);

    if (!task)
      return res.status(404).json({ message: "Task not found" });

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

    if (!task)
      return res.status(404).json({
        message: "Task not found",
      });

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

    if (!task)
      return res.status(404).json({
        message: "Task not found",
      });

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
     * PAY STUDENT
     * (You may later move this to a Payment model if needed)
     */
    const student = await User.findById(task.submission.student);

    if (student) {
      student.wallet = (student.wallet || 0) + task.budget;
      student.tasksCompleted =
        (student.tasksCompleted || 0) + 1;

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
 * CLIENT DECLINE WORK (NEW)
 * ===============================
 * - Increments attemptCount
 * - If attempts < maxAttempts, student can resubmit
 * - If attempts >= maxAttempts, task is marked declined and chat should be locked
 */
exports.declineWork = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId);

    if (!task)
      return res.status(404).json({
        message: "Task not found",
      });

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

    // Increase attempt count
    task.attemptCount = (task.attemptCount || 0) + 1;

    // Clear submission when declined
    task.submission = null;

    if (task.attemptCount >= (task.maxAttempts || 3)) {
      // Hard decline: no more submissions or messages
      task.status = "declined";
    } else {
      // Allow student to try again
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

    if (!task)
      return res.status(404).json({
        message: "Task not found",
      });

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
 * GET STUDENT TASKS
 * ===============================
 */
exports.getStudentTasks = async (req, res) => {
  try {
    const tasks = await Task.find({
      student: req.user.id,
    });

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
    });

    res.json(tasks);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed",
      error: err.message,
    });
  }
};
