// backend/controllers/adminController.js
const mongoose = require("mongoose");
const User = require("../models/User");
const Task = require("../models/Task");
const Payment = require("../models/Payment");

// ====================================
// HELPERS (RESTORED 100%)
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
// OVERVIEW STATS (MODIFIED FOR WORKFLOW)
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
      underReviewTasks,
      awaitingAdvanceTasks,
      awaitingFinalTasks,
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
      Task.countDocuments({ status: "under_review" }),
      Task.countDocuments({ status: "awaiting_advance" }),
      Task.countDocuments({ status: "awaiting_final_payment" }),
      Task.countDocuments({ status: "completed" }),
      Payment.countDocuments(),
      Payment.countDocuments({ status: { $in: ["awaiting_advance", "partially_paid", "fully_paid"] } }),
      Payment.countDocuments({ status: "released" }),
      Payment.aggregate([
        {
          $group: {
            _id: null,
            totalGrossAmount: { $sum: { $ifNull: ["$amount", 0] } },
            totalNetToStudent: { $sum: { $ifNull: ["$netToStudent", 0] } },
            totalPlatformFee: { 
                $sum: { 
                    $add: [
                        { $ifNull: ["$platformFeeClient", 0] }, 
                        { $ifNull: ["$platformFeeStudent", 0] }
                    ] 
                } 
            },
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
      underReviewTasks,
      awaitingAdvanceTasks,
      awaitingFinalTasks,
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
// TASK STATS (MODIFIED FOR WORKFLOW)
// ====================================

exports.getTaskStats = async (req, res) => {
  try {
    const [total, open, assigned, review, awaitingAdvance, awaitingFinal, completed, declined] = await Promise.all([
      Task.countDocuments(),
      Task.countDocuments({ status: "open" }),
      Task.countDocuments({ status: "assigned" }),
      Task.countDocuments({ status: "under_review" }),
      Task.countDocuments({ status: "awaiting_advance" }),
      Task.countDocuments({ status: "awaiting_final_payment" }),
      Task.countDocuments({ status: "completed" }),
      Task.countDocuments({ status: "declined" }),
    ]);

    return res.json({
      total,
      open,
      assigned,
      under_review: review,
      awaiting_advance: awaitingAdvance,
      awaiting_final_payment: awaitingFinal,
      completed,
      declined
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to load task stats");
  }
};

// ====================================
// COMPLETED TASKS (RESTORED)
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
// PENDING PAYMENTS (MODIFIED FOR VERIFICATION)
// ====================================

exports.getPendingPayments = async (req, res) => {
  try {
    // Fetches payments that need Admin to verify 20% or 80% or final release
    const payments = await Payment.find({ 
        status: { $in: ["awaiting_advance", "partially_paid", "fully_paid", "approved"] } 
    })
      .populate(
        "student",
        "name email wallet pendingEarnings totalEarningsReleased bankAccountNumber ifscCode bankAccountHolderName bankName"
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
// PAY STUDENT (RELEASE LOGIC - SYNCED)
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

    // Workflow check: Payment is only ready for final release if fully paid or approved
    const payment = await Payment.findOne({
      task: taskId,
      status: { $in: ["fully_paid", "approved", "completed"] },
    }).session(session);

    if (!payment) {
      await session.abortTransaction();
      return res.status(404).json({
        message: "Eligible payment record not found for final release",
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

    // Logic: Use netToStudent if available (budget minus SKILEN fees)
    const amount = toMoneyNumber(payment.netToStudent || payment.amount || task.budget);

    if (amount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({
        message: "Invalid payment amount",
      });
    }

    const currentWallet = toMoneyNumber(student.wallet);
    const currentPending = toMoneyNumber(student.pendingEarnings);
    const currentReleased = toMoneyNumber(student.totalEarningsReleased);

    // Finalize ledger
    payment.status = "released";
    payment.releasedAt = new Date();
    await payment.save({ session });

    // Update Virtual Wallet
    student.wallet = currentWallet + amount;
    student.pendingEarnings = Math.max(0, currentPending - amount);
    student.totalEarningsReleased = currentReleased + amount;
    await student.save({ session });

    await session.commitTransaction();

    return res.json({
      message: "Payment released successfully to student wallet",
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