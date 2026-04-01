const User = require("../models/User");
const Task = require("../models/Task");
const Payment = require("../models/Payment");

// ====================================
// OVERVIEW STATS
// ====================================

exports.getOverviewStats = async (req, res) => {
  try {
    const [totalUsers, totalStudents, totalTasks, totalPayments] =
      await Promise.all([
        User.countDocuments(),
        User.countDocuments({ role: "student" }),
        Task.countDocuments(),
        Payment.countDocuments(),
      ]);

    return res.json({
      totalUsers,
      totalStudents,
      totalTasks,
      totalPayments,
    });
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to load overview stats",
    });
  }
};

// ====================================
// TASK STATS
// ====================================

exports.getTaskStats = async (req, res) => {
  try {
    const [total, completed, pending] = await Promise.all([
      Task.countDocuments(),
      Task.countDocuments({ status: "completed" }),
      Task.countDocuments({ status: "pending" }),
    ]);

    return res.json({
      total,
      completed,
      pending,
    });
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to load task stats",
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
      .populate("client", "name email")
      .sort({ updatedAt: -1, createdAt: -1 });

    return res.json(tasks);
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to load completed tasks",
    });
  }
};

// ====================================
// PENDING PAYMENTS
// ====================================

exports.getPendingPayments = async (req, res) => {
  try {
    const payments = await Payment.find({ status: "held" })
      .populate("student", "name email wallet pendingEarnings totalEarningsReleased")
      .populate("task", "title budget")
      .sort({ createdAt: -1 });

    return res.json(payments);
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to load pending payments",
    });
  }
};

// ====================================
// PAY STUDENT
// ====================================

exports.payStudent = async (req, res) => {
  try {
    const { taskId } = req.params;

    if (!taskId) {
      return res.status(400).json({
        message: "Task id is required",
      });
    }

    const payment = await Payment.findOne({ task: taskId });

    if (!payment) {
      return res.status(404).json({
        message: "Payment not found",
      });
    }

    if (payment.status === "released") {
      return res.status(400).json({
        message: "Payment already released",
      });
    }

    const student = await User.findById(payment.student);

    if (!student) {
      return res.status(404).json({
        message: "Student not found",
      });
    }

    const rawNetToStudent = Number(payment.netToStudent);
    const rawAmount = Number(payment.amount);

    const amount =
      Number.isFinite(rawNetToStudent) && rawNetToStudent > 0
        ? rawNetToStudent
        : Number.isFinite(rawAmount) && rawAmount > 0
        ? rawAmount
        : 0;

    if (amount <= 0) {
      return res.status(400).json({
        message: "Invalid payment amount",
      });
    }

    payment.status = "released";
    payment.releasedAt = new Date();
    await payment.save();

    const currentWallet = Number(student.wallet) || 0;
    const currentPending = Number(student.pendingEarnings) || 0;
    const currentReleased = Number(student.totalEarningsReleased) || 0;

    student.wallet = currentWallet + amount;
    student.pendingEarnings = Math.max(0, currentPending - amount);
    student.totalEarningsReleased = currentReleased + amount;

    await student.save();

    return res.json({
      message: "Payment released successfully",
      paymentId: payment._id,
      taskId,
      amountReleased: amount,
      wallet: student.wallet,
      pendingEarnings: student.pendingEarnings,
      totalEarningsReleased: student.totalEarningsReleased,
    });
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to release payment",
    });
  }
};