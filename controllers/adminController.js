// backend/controllers/adminController.js
const User = require("../models/User");
const Task = require("../models/Task");

/**
 * Standardized error handler
 */
const sendServerError = (res, error, fallbackMessage) => {
  console.error(`AdminController Error: ${error.message || fallbackMessage}`);
  return res.status(500).json({
    message: error.message || fallbackMessage,
  });
};

// =============================================================================
// 1. DASHBOARD ANALYTICS & GROWTH (Fixes 404 errors)
// =============================================================================

exports.getOverviewStats = async (req, res) => {
  try {
    const [uTotal, uStu, uCli, tTotal, tCom, tOpen] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "client" }),
      Task.countDocuments({}),
      Task.countDocuments({ status: "completed" }),
      Task.countDocuments({ status: "open" }),
    ]);

    return res.json({
      users: { total: uTotal, students: uStu, clients: uCli },
      tasks: { total: tTotal, completed: tCom, open: tOpen },
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to load overview stats");
  }
};

exports.getGrowthStats = async (req, res) => {
  try {
    const { metric } = req.query;
    const TargetModel = metric === "students" ? User : Task;

    const growth = await TargetModel.aggregate([
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    return res.json(growth);
  } catch (error) {
    return sendServerError(res, error, "Failed to load trend data");
  }
};

exports.getTaskStats = async (req, res) => {
  try {
    const stats = await Task.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    return res.json({ byStatus: stats });
  } catch (error) {
    return sendServerError(res, error, "Failed to load funnel stats");
  }
};

// =============================================================================
// 2. FILTERS & SEARCH TOOLS (Fixes 404 errors)
// =============================================================================

exports.getTaskFilters = async (req, res) => {
  try {
    const [locations, domains] = await Promise.all([
      Task.distinct("location"),
      Task.distinct("domain"),
    ]);

    return res.json({
      locations: locations.filter(Boolean),
      domains: domains.filter(Boolean),
      companies: [], // Logic changed to focus on individual vetting
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to load dynamic filters");
  }
};

/**
 * Requirement: Filter by location/skills and sort by tasks done.
 */
exports.getSuggestedStudents = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { location, skill } = req.query;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    let query = { role: "student", isApproved: true };

    // Skill Filter: Search specifically for skill OR use task requirements
    if (skill) {
      query.skills = { $in: [new RegExp(skill, "i")] };
    } else if (task.requiredSkills && task.requiredSkills.length > 0) {
      query.skills = { $in: task.requiredSkills };
    }

    // Location Filter
    if (location) {
      query.location = new RegExp(location, "i");
    }

    // Requirement: Sort by most tasks completed (Experience)
    const candidates = await User.find(query)
      .select("name email mobile location skills tasksCompleted totalScore totalScoreCount")
      .sort({ tasksCompleted: -1 })
      .lean();

    return res.json(candidates);
  } catch (error) {
    return sendServerError(res, error, "Error identifying candidates");
  }
};

// =============================================================================
// 3. STUDENT & USER MANAGEMENT
// =============================================================================

/**
 * Requirement: See complete details like mail, contact, and tasks on click.
 */
exports.getStudentDetails = async (req, res) => {
  try {
    const { studentId } = req.params;

    const student = await User.findById(studentId).select("-password").lean();
    if (!student) return res.status(404).json({ message: "Student not found" });

    // Fetch full work history for this student
    const history = await Task.find({ student: studentId })
      .select("title status budget createdAt feedback score")
      .sort({ createdAt: -1 });

    return res.json({ student, history });
  } catch (error) {
    return sendServerError(res, error, "Failed to fetch full student profile");
  }
};

exports.getTopStudents = async (req, res) => {
  try {
    const top = await User.find({ role: "student" })
      .select("name location tasksCompleted totalScore")
      .sort({ tasksCompleted: -1 })
      .limit(10);
    return res.json(top);
  } catch (error) {
    return sendServerError(res, error, "Failed to load rankings");
  }
};

exports.updateUserApproval = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isApproved: req.body.isApproved },
      { new: true }
    );
    return res.json({ message: "Status updated successfully", user });
  } catch (error) {
    return sendServerError(res, error, "Approval update failed");
  }
};

// =============================================================================
// 4. TASK & PAYMENT CHAIN ACTIONS
// =============================================================================

/**
 * Logic: Student work is locked until Admin checks it.
 */
exports.toggleSubmissionVisibility = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { canView } = req.body;

    const task = await Task.findByIdAndUpdate(
      taskId,
      { clientCanViewSubmission: canView },
      { new: true }
    );

    return res.json({
      message: canView ? "Submission released to Client" : "Submission locked",
      canView: task.clientCanViewSubmission,
    });
  } catch (error) {
    return sendServerError(res, error, "Permission update failed");
  }
};

/**
 * Requirement: Client -> Admin payment confirmed.
 */
exports.confirmClientPayment = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(
      req.params.taskId,
      { adminReceivedPayment: true },
      { new: true }
    );
    return res.json({ message: "Payment from client verified by Admin", task });
  } catch (error) {
    return sendServerError(res, error, "Update failed");
  }
};

/**
 * Requirement: Admin -> Student payout confirmed.
 */
exports.confirmStudentPayout = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(
      req.params.taskId,
      { adminPaidStudent: true },
      { new: true }
    );
    return res.json({ message: "Payout to student confirmed by Admin", task });
  } catch (error) {
    return sendServerError(res, error, "Update failed");
  }
};

// =============================================================================
// 5. RESOURCE LISTS
// =============================================================================

exports.getAllTasks = async (req, res) => {
  try {
    const tasks = await Task.find({})
      .populate("client", "name mobile guestInfo")
      .populate("student", "name mobile")
      .sort({ createdAt: -1 });
    return res.json(tasks);
  } catch (error) {
    return sendServerError(res, error, "Failed to load master task list");
  }
};

exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId)
      .populate("client student")
      .populate("requestedStudent");
    return res.json(task);
  } catch (error) {
    return sendServerError(res, error, "Task retrieval failed");
  }
};

exports.getCompletedTasks = async (req, res) => {
  try {
    const tasks = await Task.find({ status: "completed" })
      .populate("student client")
      .sort({ updatedAt: -1 });
    return res.json(tasks);
  } catch (error) {
    return sendServerError(res, error, "Failed to fetch closed tasks");
  }
};