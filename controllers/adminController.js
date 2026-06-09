// backend/controllers/adminController.js
const User = require("../models/User");
const Task = require("../models/Task");
const Message = require("../models/Message");

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
// 1. DASHBOARD ANALYTICS & GROWTH (Fixes Graph 404s)
// =============================================================================

exports.getOverviewStats = async (req, res) => {
  try {
    const [uTotal, uStu, uCli, tTotal, tCom, tOpen, tActive] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "client" }),
      Task.countDocuments({}),
      Task.countDocuments({ status: "completed" }),
      Task.countDocuments({ status: "open" }),
      Task.countDocuments({ status: "assigned" }),
    ]);

    // Matches the nested structure in AdminDashboardScreen
    return res.json({
      users: { total: uTotal, students: uStu, clients: uCli },
      tasks: { total: tTotal, completed: tCom, open: tOpen, active: tActive }
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
// 2. FILTERS & SEARCH TOOLS (Fixes Filter 404s)
// =============================================================================

exports.getTaskFilters = async (req, res) => {
  try {
    const [locations, domains] = await Promise.all([
      Task.distinct("location"),
      Task.distinct("domain"),
    ]);

    return res.json({
      locations: locations.filter(Boolean).sort(),
      domains: domains.filter(Boolean).sort(),
      companies: [],
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to load dynamic filters");
  }
};

/**
 * Candidate Vetting Search
 * Logic: Filters by location/skill and sorts by tasks done (experience).
 */
exports.getSuggestedStudents = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { location, skill } = req.query;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    let query = { role: "student", isApproved: true };

    // Skill Filter: Search specifically for skill query OR use task requirements
    if (skill && skill !== 'null' && skill.trim() !== '') {
      query.skills = { $in: [new RegExp(skill.trim(), "i")] };
    } else if (task.requiredSkills && task.requiredSkills.length > 0) {
      query.skills = { $in: task.requiredSkills };
    }

    // Location Filter
    if (location && location !== 'null' && location.trim() !== '') {
      query.location = new RegExp(location.trim(), "i");
    }

    // Sort based on tasksCompleted DESC (Requirement: Sort based on number of tasks done)
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
// 3. TASK CHAT HANDLERS (Fixes Chat 404s)
// =============================================================================

exports.getClientTaskMessages = async (req, res) => {
  try {
    const messages = await Message.find({ 
      task: req.params.taskId, 
      student: null 
    })
    .populate('sender', 'name role')
    .sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: "Error loading client chat" });
  }
};

exports.getStudentTaskMessages = async (req, res) => {
  try {
    const messages = await Message.find({ 
      task: req.params.taskId, 
      student: req.query.studentId 
    })
    .populate('sender', 'name role')
    .sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: "Error loading student chat" });
  }
};

exports.sendClientTaskMessage = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });
    const msg = await Message.create({ 
      task: task._id, 
      sender: req.user.id, 
      receiver: task.client, 
      text: req.body.text 
    });
    res.status(201).json(msg);
  } catch (err) {
    res.status(500).json({ message: "Send failed" });
  }
};

exports.sendStudentTaskMessage = async (req, res) => {
  try {
    const msg = await Message.create({ 
      task: req.params.taskId, 
      sender: req.user.id, 
      receiver: req.body.studentId, 
      student: req.body.studentId, 
      text: req.body.text 
    });
    res.status(201).json(msg);
  } catch (err) {
    res.status(500).json({ message: "Send failed" });
  }
};

// =============================================================================
// 4. TASK & PAYMENT CHAIN ACTIONS
// =============================================================================

exports.toggleSubmissionVisibility = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { canView } = req.body;
    const task = await Task.findByIdAndUpdate(taskId, { clientCanViewSubmission: canView }, { new: true });
    return res.json({ canView: task.clientCanViewSubmission });
  } catch (error) {
    return sendServerError(res, error, "Visibility update failed");
  }
};

exports.confirmClientPayment = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { adminReceivedPayment: true }, { new: true });
    return res.json({ message: "Payment verified", task });
  } catch (error) {
    return sendServerError(res, error, "Verification failed");
  }
};

exports.confirmStudentPayout = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { adminPaidStudent: true }, { new: true });
    return res.json({ message: "Payout confirmed", task });
  } catch (error) {
    return sendServerError(res, error, "Confirmation failed");
  }
};

// =============================================================================
// 5. RESOURCE DEEP-DIVE & LISTS
// =============================================================================

exports.getStudentDetails = async (req, res) => {
  try {
    const student = await User.findById(req.params.studentId).select("-password").lean();
    if (!student) return res.status(404).json({ message: "Student not found" });

    // Fetch full work history for this student
    const history = await Task.find({ student: req.params.studentId })
      .select("title status budget createdAt feedback score")
      .sort({ createdAt: -1 });

    return res.json({ student, history });
  } catch (error) {
    return sendServerError(res, error, "Failed to fetch student profile");
  }
};

exports.getAllTasks = async (req, res) => {
  try {
    const tasks = await Task.find({})
      .populate("client", "name mobile company guestInfo email")
      .populate("student", "name mobile email")
      .sort({ createdAt: -1 });
    return res.json(tasks);
  } catch (error) {
    return sendServerError(res, error, "Load failed");
  }
};

exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId).populate("client student");
    return res.json(task);
  } catch (error) {
    return sendServerError(res, error, "Retrieval failed");
  }
};

exports.getTopStudents = async (req, res) => {
  try {
    const top = await User.find({ role: "student" }).sort({ tasksCompleted: -1 }).limit(10);
    return res.json(top);
  } catch (error) {
    return sendServerError(res, error, "Load failed");
  }
};

exports.updateUserApproval = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { isApproved: req.body.isApproved }, { new: true });
    return res.json({ message: "User status updated", user });
  } catch (error) {
    return sendServerError(res, error, "Update failed");
  }
};