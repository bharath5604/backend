// backend/controllers/adminController.js
const mongoose = require("mongoose");
const User = require("../models/User");
const Task = require("../models/Task");

// ====================================
// HELPERS
// ====================================

const sendServerError = (res, error, fallbackMessage) => {
  return res.status(500).json({
    message: error.message || fallbackMessage,
  });
};

// ====================================
// OVERVIEW STATS (CLEANED OF PAYMENTS)
// ====================================

exports.getOverviewStats = async (req, res) => {
  try {
    const [
      totalUsers,
      totalStudents,
      totalClients,
      totalTasks,
      openTasks,
      assignedTasks,
      underReviewTasks,
      completedTasks,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "client" }),
      Task.countDocuments(),
      Task.countDocuments({ status: "open" }),
      Task.countDocuments({ status: "assigned" }),
      Task.countDocuments({ status: "under_review" }),
      Task.countDocuments({ status: "completed" }),
    ]);

    return res.json({
      totalUsers,
      totalStudents,
      totalClients,
      totalTasks,
      statusCounts: {
        open: openTasks,
        assigned: assignedTasks,
        under_review: underReviewTasks,
        completed: completedTasks,
      }
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to load overview stats");
  }
};

// ====================================
// TASK MANAGEMENT
// ====================================

exports.getTaskStats = async (req, res) => {
  try {
    const stats = await Task.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);

    return res.json(stats);
  } catch (error) {
    return sendServerError(res, error, "Failed to load task stats");
  }
};

/**
 * NEW: Toggle Visibility
 * Admin grants permission for the client to see the student's submission.
 */
exports.toggleSubmissionVisibility = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { canView } = req.body; // Boolean

    const task = await Task.findByIdAndUpdate(
      taskId,
      { clientCanViewSubmission: canView },
      { new: true }
    );

    if (!task) return res.status(404).json({ message: "Task not found" });

    return res.json({ 
      message: canView ? "Client can now view the submission" : "Submission hidden from client",
      clientCanViewSubmission: task.clientCanViewSubmission 
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to update visibility");
  }
};

// ====================================
// ENHANCED CANDIDATE SEARCH
// ====================================

/**
 * REWRITTEN: getSuggestedStudents
 * Includes filters for location and skills.
 * Sorts by tasksCompleted (most experienced first).
 */
exports.getSuggestedStudents = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { location, skill } = req.query;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    // Base Filter: Must be an approved student
    let query = { 
        role: "student", 
        isApproved: true 
    };

    // 1. Skill Filtering (Default to task requirements if no specific skill searched)
    if (skill) {
        query.skills = { $in: [new RegExp(skill, 'i')] };
    } else if (task.requiredSkills && task.requiredSkills.length > 0) {
        query.skills = { $in: task.requiredSkills };
    }

    // 2. Location Filtering
    if (location) {
        query.location = new RegExp(location, 'i');
    }

    const candidates = await User.find(query)
      .select("name email mobile location skills tasksCompleted totalScore totalScoreCount")
      .sort({ tasksCompleted: -1 }) // Requirement: Sort based on number of tasks done
      .lean();

    return res.json(candidates);
  } catch (error) {
    return sendServerError(res, error, "Failed to fetch candidates");
  }
};

/**
 * NEW: getStudentDetails
 * Provides complete info including contact and full task history.
 */
exports.getStudentDetails = async (req, res) => {
  try {
    const { studentId } = req.params;

    const student = await User.findById(studentId)
      .select("-password")
      .lean();

    if (!student) return res.status(404).json({ message: "Student not found" });

    // Fetch task history
    const history = await Task.find({ student: studentId })
      .select("title status budget feedback score")
      .sort({ createdAt: -1 });

    return res.json({
      profile: student,
      taskHistory: history
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to fetch student details");
  }
};

// ====================================
// COMPLETED TASKS
// ====================================

exports.getCompletedTasks = async (req, res) => {
  try {
    const tasks = await Task.find({ status: "completed" })
      .populate("student", "name email mobile")
      .populate("client", "name email mobile guestInfo")
      .sort({ updatedAt: -1 })
      .lean();

    return res.json(tasks);
  } catch (error) {
    return sendServerError(res, error, "Failed to load completed tasks");
  }
};