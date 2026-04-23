//backend/controllers/adminController.js
const mongoose = require("mongoose");
const User = require("../models/User");
const Task = require("../models/Task");
const Payment = require("../models/Payment");

// ====================================
// HELPERS
// ====================================

const sendServerError = (res, error, fallbackMessage) => {
  return res.status(500).json({
    message: error.message || fallbackMessage,
  });
};

const toMoneyNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

// ====================================
// OVERVIEW STATS
// ====================================

exports.getOverviewStats = async (req, res) => {
  try {
    const [
      totalUsers,
      totalStudents,
      totalClients,
      approvedStudents,
      totalTasks,
      openTasks,
      assignedTasks,
      completedTasks,
      totalPayments,
      heldPayments,
      releasedPayments,
      paymentsAgg,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "client" }),
      User.countDocuments({ role: "student", isApproved: true }),
      Task.countDocuments(),
      Task.countDocuments({ status: "open" }),
      Task.countDocuments({ status: "assigned" }),
      Task.countDocuments({ status: "completed" }),
      Payment.countDocuments(),
      Payment.countDocuments({ status: "held" }),
      Payment.countDocuments({ status: "released" }),
      Payment.aggregate([
        {
          $group: {
            _id: null,
            totalGrossAmount: { $sum: { $ifNull: ["$amount", 0] } },
            totalNetToStudent: { $sum: { $ifNull: ["$netToStudent", 0] } },
            totalPlatformFee: { $sum: { $ifNull: ["$platformFee", 0] } },
          },
        },
      ]),
    ]);

    const paymentTotals = paymentsAgg[0] || {
      totalGrossAmount: 0,
      totalNetToStudent: 0,
      totalPlatformFee: 0,
    };

    return res.json({
      totalUsers,
      totalStudents,
      totalClients,
      approvedStudents,
      totalTasks,
      openTasks,
      assignedTasks,
      completedTasks,
      totalPayments,
      heldPayments,
      releasedPayments,
      totalGrossAmount: toMoneyNumber(paymentTotals.totalGrossAmount),
      totalNetToStudent: toMoneyNumber(paymentTotals.totalNetToStudent),
      totalPlatformFee: toMoneyNumber(paymentTotals.totalPlatformFee),
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to load overview stats");
  }
};

// ====================================
// TASK STATS
// ====================================

exports.getTaskStats = async (req, res) => {
  try {
    const [total, open, assigned, completed, pending] = await Promise.all([
      Task.countDocuments(),
      Task.countDocuments({ status: "open" }),
      Task.countDocuments({ status: "assigned" }),
      Task.countDocuments({ status: "completed" }),
      Task.countDocuments({ status: "pending" }),
    ]);

    return res.json({
      total,
      open,
      assigned,
      completed,
      pending,
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to load task stats");
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
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    return res.json(tasks);
  } catch (error) {
    return sendServerError(res, error, "Failed to load completed tasks");
  }
};

// ====================================
// PENDING PAYMENTS
// ====================================

exports.getPendingPayments = async (req, res) => {
  try {
    const payments = await Payment.find({ status: "held" })
      .populate(
        "student",
        "name email wallet pendingEarnings totalEarningsReleased"
      )
      .populate("task", "title budget status")
      .sort({ createdAt: -1 })
      .lean();

    return res.json(payments);
  } catch (error) {
    return sendServerError(res, error, "Failed to load pending payments");
  }
};

// ====================================
// PAY STUDENT
// ====================================

exports.payStudent = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { taskId } = req.params;

    if (!taskId || !mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json({
        message: "Valid task id is required",
      });
    }

    session.startTransaction();

    const payment = await Payment.findOne({
      task: taskId,
      status: { $in: ["held", "completed"] },
    }).session(session);

    if (!payment) {
      await session.abortTransaction();
      return res.status(404).json({
        message: "Pending payment not found for this task",
      });
    }

    if (payment.status === "released") {
      await session.abortTransaction();
      return res.status(400).json({
        message: "Payment already released",
      });
    }

    const student = await User.findById(payment.student).session(session);

    if (!student) {
      await session.abortTransaction();
      return res.status(404).json({
        message: "Student not found",
      });
    }

    const task = await Task.findById(taskId).session(session);

    if (!task) {
      await session.abortTransaction();
      return res.status(404).json({
        message: "Task not found",
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
      await session.abortTransaction();
      return res.status(400).json({
        message: "Invalid payment amount",
      });
    }

    const currentWallet = toMoneyNumber(student.wallet);
    const currentPending = toMoneyNumber(student.pendingEarnings);
    const currentReleased = toMoneyNumber(student.totalEarningsReleased);

    payment.status = "released";
    payment.releasedAt = new Date();
    await payment.save({ session });

    student.wallet = currentWallet + amount;
    student.pendingEarnings = Math.max(0, currentPending - amount);
    student.totalEarningsReleased = currentReleased + amount;
    await student.save({ session });

    await session.commitTransaction();

    return res.json({
      message: "Payment released successfully",
      paymentId: payment._id,
      taskId: task._id,
      taskTitle: task.title || "",
      studentId: student._id,
      studentName: student.name || "",
      amountReleased: amount,
      wallet: student.wallet,
      pendingEarnings: student.pendingEarnings,
      totalEarningsReleased: student.totalEarningsReleased,
      releasedAt: payment.releasedAt,
    });
  } catch (error) {
    await session.abortTransaction();
    return sendServerError(res, error, "Failed to release payment");
  } finally {
    session.endSession();
  }
};