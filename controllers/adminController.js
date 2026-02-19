const User = require("../models/User");
const Task = require("../models/Task");
const Payment = require("../models/Payment");

// ====================================
// OVERVIEW STATS
// ====================================

exports.getOverviewStats = async (req, res) => {
  try {
    res.json({
      totalUsers: await User.countDocuments(),
      totalStudents: await User.countDocuments({ role: "student" }),
      totalTasks: await Task.countDocuments(),
      totalPayments: await Payment.countDocuments(),
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// ====================================
// TASK STATS
// ====================================

exports.getTaskStats = async (req, res) => {
  try {
    res.json({
      total: await Task.countDocuments(),
      completed: await Task.countDocuments({ status: "completed" }),
      pending: await Task.countDocuments({ status: "pending" }),
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// ====================================
// COMPLETED TASKS
// ====================================

exports.getCompletedTasks = async (req, res) => {
  try {
    const tasks = await Task.find({ status: "completed" })
      .populate("student", "name email")
      .populate("client", "name email");

    res.json(tasks);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// ====================================
// PENDING PAYMENTS
// ====================================

exports.getPendingPayments = async (req, res) => {
  try {
    const payments = await Payment.find({
      status: "held",
    })
      .populate("student", "name email")
      .populate("task", "title budget");

    res.json(payments);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// ====================================
// PAY STUDENT
// ====================================

exports.payStudent = async (req, res) => {
  try {
    const payment = await Payment.findOne({
      task: req.params.taskId,
    });

    if (!payment) {
      return res.status(404).json({
        message: "Payment not found",
      });
    }

    // mark payment as released
    payment.status = "released";
    await payment.save();

    // find student
    const student = await User.findById(payment.student);
    if (!student) {
      return res.status(404).json({
        message: "Student not found",
      });
    }

    // use netToStudent if present, else amount
    const amount =
      typeof payment.netToStudent === "number" && !Number.isNaN(payment.netToStudent)
        ? payment.netToStudent
        : payment.amount || 0;

    // update wallet balance
    student.wallet = (student.wallet || 0) + amount;

    // move from pendingEarnings -> totalEarningsReleased
    const currentPending = student.pendingEarnings || 0;
    const currentReleased = student.totalEarningsReleased || 0;

    student.pendingEarnings = Math.max(0, currentPending - amount);
    student.totalEarningsReleased = currentReleased + amount;

    await student.save();

    res.json({
      message: "Payment released successfully",
      wallet: student.wallet,
      pendingEarnings: student.pendingEarnings,
      totalEarningsReleased: student.totalEarningsReleased,
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};
