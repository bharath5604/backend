const Task = require("../models/Task");
const User = require("../models/User");


/**
 * =====================================
 * GET ALL COMPLETED TASKS
 * =====================================
 */
exports.getCompletedTasks = async (req, res) => {
  try {

    if (req.user.role !== "admin") {
      return res.status(403).json({
        message: "Access denied",
      });
    }

    const tasks = await Task.find({
      status: "completed",
    })
      .populate("student", "name email wallet")
      .populate("client", "name email")
      .sort({ updatedAt: -1 });


    res.json(tasks);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: "Failed to fetch",
      error: err.message,
    });

  }
};



/**
 * =====================================
 * GET PENDING PAYMENTS
 * =====================================
 */
exports.getPendingPayments = async (req, res) => {

  try {

    if (req.user.role !== "admin") {
      return res.status(403).json({
        message: "Access denied",
      });
    }

    const tasks = await Task.find({
      status: "completed",
      paymentStatus: "pending",
    })
      .populate("student", "name email wallet")
      .populate("client", "name email");


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
 * =====================================
 * MARK PAYMENT AS PAID
 * =====================================
 */
exports.payStudent = async (req, res) => {

  try {

    if (req.user.role !== "admin") {

      return res.status(403).json({
        message: "Access denied",
      });

    }


    const task = await Task.findById(req.params.taskId);

    if (!task)
      return res.status(404).json({
        message: "Task not found",
      });



    if (task.paymentStatus === "paid") {

      return res.json({
        message: "Already paid",
      });

    }



    const student = await User.findById(task.student);

    if (!student)
      return res.status(404).json({
        message: "Student not found",
      });



    /**
     * UPDATE WALLET
     */

    student.wallet =
      (student.wallet || 0) + task.budget;

    await student.save();



    /**
     * UPDATE TASK
     */

    task.paymentStatus = "paid";

    task.paidAt = new Date();

    await task.save();



    res.json({

      message: "Payment successful",

      wallet: student.wallet,

      task,

    });


  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: "Payment failed",
      error: err.message,
    });

  }
};
