// backend/controllers/adminController.js
const mongoose = require("mongoose");
const User = require("../models/User");
const Task = require("../models/Task");

const sendServerError = (res, error, fallbackMessage) => {
  return res.status(500).json({
    message: error.message || fallbackMessage,
  });
};

// ====================================
// 1. DASHBOARD & GROWTH STATS
// ====================================

/**
 * FIXED: Overview Stats
 */
exports.getOverviewStats = async (req, res) => {
  try {
    const [uAll, tAll, tCom, tOpen] = await Promise.all([
      User.countDocuments({}), 
      Task.countDocuments({}),
      Task.countDocuments({ status: 'completed' }),
      Task.countDocuments({ status: 'open' })
    ]);
    
    return res.json({
      users: { total: uAll },
      tasks: { total: tAll, completed: tCom, open: tOpen }
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to load overview");
  }
};

/**
 * FIXED: getGrowthStats (Resolves 404 error)
 */
exports.getGrowthStats = async (req, res) => {
  try {
    const { metric } = req.query;
    const Model = metric === 'students' ? User : Task;

    const growth = await Model.aggregate([
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]);

    return res.json(growth);
  } catch (error) {
    return sendServerError(res, error, "Failed to load growth stats");
  }
};

// ====================================
// 2. FILTERS & SEARCH
// ====================================

/**
 * FIXED: getTaskFilters (Resolves 404 error)
 */
exports.getTaskFilters = async (req, res) => {
  try {
    const [locations, domains] = await Promise.all([
      Task.distinct('location'),
      Task.distinct('domain')
    ]);
    return res.json({
      locations: locations.filter(Boolean),
      domains: domains.filter(Boolean),
      companies: [] // Placeholder if needed later
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to load filters");
  }
};

/**
 * REWRITTEN: Candidate vetting with filtering and completion count sorting
 */
exports.getSuggestedStudents = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { location, skill } = req.query;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    let query = { role: "student", isApproved: true };

    if (skill) {
      query.skills = { $in: [new RegExp(skill, 'i')] };
    } else if (task.requiredSkills && task.requiredSkills.length > 0) {
      query.skills = { $in: task.requiredSkills };
    }

    if (location) {
      query.location = new RegExp(location, 'i');
    }

    const candidates = await User.find(query)
      .select("name email mobile location skills tasksCompleted totalScore totalScoreCount")
      .sort({ tasksCompleted: -1 }) // Sort by experience
      .lean();

    return res.json(candidates);
  } catch (error) {
    return sendServerError(res, error, "Failed to search candidates");
  }
};

// ====================================
// 3. TASK & SUBMISSION ACTIONS
// ====================================

exports.toggleSubmissionVisibility = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { canView } = req.body;

    const task = await Task.findByIdAndUpdate(
      taskId,
      { clientCanViewSubmission: canView },
      { new: true }
    );

    return res.json({ canView: task.clientCanViewSubmission });
  } catch (error) {
    return sendServerError(res, error, "Failed to update visibility");
  }
};

/**
 * NEW: Admin records Client -> Admin payment
 */
exports.confirmClientPayment = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(
      req.params.taskId,
      { adminReceivedPayment: true },
      { new: true }
    );
    return res.json({ message: "Payment from client verified", task });
  } catch (error) {
    return sendServerError(res, error, "Update failed");
  }
};

/**
 * NEW: Admin records Admin -> Student payout
 */
exports.confirmStudentPayout = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(
      req.params.taskId,
      { adminPaidStudent: true },
      { new: true }
    );
    return res.json({ message: "Payout to student recorded", task });
  } catch (error) {
    return sendServerError(res, error, "Update failed");
  }
};

// ====================================
// 4. DATA DEEP-DIVE
// ====================================

exports.getStudentDetails = async (req, res) => {
  try {
    const student = await User.findById(req.params.studentId).select("-password").lean();
    if (!student) return res.status(404).json({ message: "Student not found" });

    const history = await Task.find({ student: req.params.studentId })
      .select("title status budget createdAt feedback score")
      .sort({ createdAt: -1 });

    return res.json({ student, history });
  } catch (error) {
    return sendServerError(res, error, "Error fetching details");
  }
};

exports.getTaskStats = async (req, res) => {
    try {
      const stats = await Task.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
      return res.json({ byStatus: stats });
    } catch (error) {
      return sendServerError(res, error, "Failed load task stats");
    }
};

exports.getCompletedTasks = async (req, res) => {
  try {
    const tasks = await Task.find({ status: "completed" })
      .populate("student", "name email mobile")
      .populate("client", "name email mobile guestInfo")
      .sort({ updatedAt: -1 });
    return res.json(tasks);
  } catch (error) {
    return sendServerError(res, error, "Failed to load completed tasks");
  }
};