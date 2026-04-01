const express = require("express");
const router = express.Router();

const User = require("../models/User");
const Task = require("../models/Task");
const Payment = require("../models/Payment");
const Bid = require("../models/Bid");

const verifyJWT = require("../middleware/authMiddleware");

/*
=====================================
ADMIN CHECK
=====================================
*/

const ensureAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      message: "Admin only",
    });
  }
  next();
};

/*
=====================================
ADMIN USERS LIST
/api/admin/users
=====================================
*/

router.get("/users", verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { role, company, location, domain } = req.query;

    const filter = {};
    if (role) filter.role = String(role).trim();
    if (company) filter.company = String(company).trim();
    if (location) filter.location = String(location).trim();
    if (domain) filter.domain = String(domain).trim();

    const users = await User.find(filter).select("-password");

    return res.json(users);
  } catch (err) {
    console.error("Error in /api/admin/users", err);
    return res.status(500).json({
      message: "Error loading users",
      error: err.message,
    });
  }
});

/*
=====================================
ADMIN UPDATE USER APPROVAL
PATCH /api/admin/users/:id/approve
=====================================
*/

router.patch(
  "/users/:id/approve",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isApproved } = req.body;

      const user = await User.findByIdAndUpdate(
        id,
        { isApproved: !!isApproved },
        { new: true }
      ).select("-password");

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      return res.json({
        message: "Approval updated",
        user,
      });
    } catch (err) {
      console.error("Error in PATCH /api/admin/users/:id/approve", err);
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
ADMIN TASKS LIST
/api/admin/tasks
=====================================
*/

router.get("/tasks", verifyJWT, ensureAdmin, async (req, res) => {
  try {
    const { company, location, domain } = req.query;

    const filter = {};
    if (company) filter.company = String(company).trim();
    if (location) filter.location = String(location).trim();
    if (domain) filter.domain = String(domain).trim();

    const tasks = await Task.find(filter)
      .populate("client", "name email")
      .populate("student", "name email");

    return res.json(tasks);
  } catch (err) {
    console.error("Error in /api/admin/tasks", err);
    return res.status(500).json({
      message: "Error loading tasks",
      error: err.message,
    });
  }
});

/*
=====================================
TASK FILTER VALUES (NEW)
/api/admin/tasks/filters
Return distinct lists for dropdowns: company, location, domain
=====================================
*/

router.get(
  "/tasks/filters",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const [companies, locations, domains] = await Promise.all([
        Task.distinct("company"),
        Task.distinct("location"),
        Task.distinct("domain"),
      ]);

      return res.json({
        companies: companies.filter(Boolean),
        locations: locations.filter(Boolean),
        domains: domains.filter(Boolean),
      });
    } catch (err) {
      console.error("Error in /api/admin/tasks/filters", err);
      return res.status(500).json({
        message: "Error loading task filters",
        error: err.message,
      });
    }
  }
);

/*
=====================================
STUDENT DASHBOARD (DETAIL)
/api/admin/students/:id/dashboard
=====================================
*/

router.get(
  "/students/:id/dashboard",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const studentId = req.params.id;

      const student = await User.findById(studentId).select("-password");
      if (!student || student.role !== "student") {
        return res.status(404).json({ message: "Student not found" });
      }

      const [totalTasks, completedTasks, totalBids, totalPayments] =
        await Promise.all([
          Task.countDocuments({ student: studentId }),
          Task.countDocuments({ student: studentId, status: "completed" }),
          Bid.countDocuments({ student: studentId }),
          Payment.countDocuments({
            student: studentId,
            status: "completed",
          }),
        ]);

      return res.json({
        student,
        totalTasks,
        completedTasks,
        totalBids,
        totalPayments,
      });
    } catch (err) {
      console.error("Error in /api/admin/students/:id/dashboard", err);
      return res.status(500).json({
        message: "Error loading student dashboard",
        error: err.message,
      });
    }
  }
);

/*
=====================================
OVERVIEW STATS
/api/admin/stats/overview
=====================================
*/

router.get(
  "/stats/overview",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const [
        totalUsers,
        totalStudents,
        totalClients,
        totalAdmins,
        totalTasks,
        totalBids,
        paymentsAgg,
        completedAgg,
        clientProposedAgg,
      ] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ role: "student" }),
        User.countDocuments({ role: "client" }),
        User.countDocuments({ role: "admin" }),
        Task.countDocuments(),
        Bid.countDocuments({}),
        Payment.aggregate([
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$netToStudent" },
            },
          },
        ]),
        Payment.aggregate([
          {
            $match: { status: "completed" },
          },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$netToStudent" },
            },
          },
        ]),
        Task.aggregate([
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$budget" },
            },
          },
        ]),
      ]);

      const totalPayments =
        paymentsAgg.length > 0 ? paymentsAgg[0].totalAmount : 0;
      const completedPayments =
        completedAgg.length > 0 ? completedAgg[0].totalAmount : 0;
      const totalClientProposed =
        clientProposedAgg.length > 0 ? clientProposedAgg[0].totalAmount : 0;

      return res.json({
        totalUsers,
        totalStudents,
        totalClients,
        totalAdmins,
        totalTasks,
        totalBids,
        totalPayments,
        completedPayments,
        totalClientProposed,
      });
    } catch (err) {
      console.error("Error in /api/admin/stats/overview", err);
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
PAYMENT QUOTE STATS
/api/admin/stats/payments
=====================================
*/

router.get(
  "/stats/payments",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const acceptedAgg = await Payment.aggregate([
        {
          $match: {
            status: { $in: ["held", "completed"] },
          },
        },
        {
          $lookup: {
            from: "bids",
            localField: "bid",
            foreignField: "_id",
            as: "bid",
          },
        },
        { $unwind: "$bid" },
        {
          $match: {
            "bid.status": "accepted",
          },
        },
        {
          $group: {
            _id: null,
            totalAcceptedQuotes: { $sum: "$bid.quote" },
          },
        },
      ]);

      const totalAcceptedQuotes =
        acceptedAgg.length > 0 ? acceptedAgg[0].totalAcceptedQuotes : 0;

      const completedAgg = await Payment.aggregate([
        { $match: { status: "completed" } },
        {
          $lookup: {
            from: "bids",
            localField: "bid",
            foreignField: "_id",
            as: "bid",
          },
        },
        { $unwind: "$bid" },
        { $match: { "bid.status": "accepted" } },
        {
          $group: {
            _id: null,
            totalCompletedQuotes: { $sum: "$bid.quote" },
          },
        },
      ]);

      const totalCompletedQuotes =
        completedAgg.length > 0 ? completedAgg[0].totalCompletedQuotes : 0;

      const totalPendingQuotes = totalAcceptedQuotes - totalCompletedQuotes;

      return res.json({
        totalAcceptedQuotes,
        totalCompletedQuotes,
        totalPendingQuotes,
      });
    } catch (err) {
      console.error("Error in /api/admin/stats/payments", err);
      return res.status(500).json({
        message: "Error computing payment stats",
        error: err.message,
      });
    }
  }
);

/*
=====================================
TASK STATS
(getTaskStats card)
=====================================
*/

router.get(
  "/getTaskStats",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const total = await Task.countDocuments();
      const completed = await Task.countDocuments({
        status: "completed",
      });
      const pending = total - completed;

      return res.json({
        total,
        completed,
        pending,
      });
    } catch (err) {
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
DOMAIN STATS
=====================================
*/

router.get(
  "/getDomainStats",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const stats = await Task.aggregate([
        {
          $group: {
            _id: "$domain",
            total: { $sum: 1 },
            completed: {
              $sum: {
                $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
              },
            },
          },
        },
      ]);

      const mapped = stats.map((s) => ({
        domain: !s._id || s._id === "general" ? "Other" : s._id,
        total: s.total,
        completed: s.completed,
      }));

      return res.json(mapped);
    } catch (err) {
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
TOP STUDENTS
=====================================
*/

router.get(
  "/getTopStudents",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const stats = await Payment.aggregate([
        { $match: { status: "completed" } },
        {
          $lookup: {
            from: "bids",
            localField: "bid",
            foreignField: "_id",
            as: "bid",
          },
        },
        { $unwind: "$bid" },
        { $match: { "bid.status": "accepted" } },
        {
          $group: {
            _id: "$student",
            total: { $sum: "$bid.quote" },
          },
        },
        { $sort: { total: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "studentDoc",
          },
        },
        { $unwind: "$studentDoc" },
        {
          $project: {
            _id: 0,
            studentId: "$_id",
            name: "$studentDoc.name",
            email: "$studentDoc.email",
            total: 1,
          },
        },
      ]);

      return res.json(stats);
    } catch (err) {
      console.error("Error in /api/admin/getTopStudents", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/*
=====================================
TIME SERIES
=====================================
*/

router.get(
  "/getTimeSeriesStats",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const stats = await Task.aggregate([
        {
          $group: {
            _id: {
              month: { $month: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.month": 1 } },
      ]);

      return res.json(stats);
    } catch (err) {
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
TASK FUNNEL
=====================================
*/

router.get(
  "/getTaskFunnelStats",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const stats = {
        total: await Task.countDocuments(),
        assigned: await Task.countDocuments({
          student: { $ne: null },
        }),
        completed: await Task.countDocuments({
          status: "completed",
        }),
      };

      return res.json(stats);
    } catch (err) {
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
ADMIN PAYMENTS LIST
GET /api/admin/payments?status=created|held|completed|cancelled
=====================================
*/

router.get(
  "/payments",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { status } = req.query;
      const filter = {};
      if (status) filter.status = String(status).trim();

      const payments = await Payment.find(filter)
        .populate("student", "name email")
        .populate("client", "name email")
        .populate("task", "title budget status")
        .populate("bid", "quote amount");

      return res.json(payments);
    } catch (err) {
      console.error("Error in GET /api/admin/payments", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/*
=====================================
ADMIN UPDATE PAYMENT STATUS (generic)
PATCH /api/admin/payments/:id/status
body: { status, adminNote? }
=====================================
*/

router.patch(
  "/payments/:id/status",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, adminNote } = req.body;

      const payment = await Payment.findById(id);
      if (!payment) {
        return res.status(404).json({ message: "Payment not found" });
      }

      if (status) {
        payment.status = status;
      }
      if (adminNote) {
        payment.declineReason = adminNote;
      }

      await payment.save();

      return res.json({
        message: "Payment status updated",
        payment,
      });
    } catch (err) {
      console.error("Error in PATCH /api/admin/payments/:id/status", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

/*
=====================================
PENDING PAYMENTS
Show only payments approved by client (Payment.status = 'held')
=====================================
*/

router.get(
  "/getPendingPayments",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const payments = await Payment.find({
        status: "held",
      })
        .populate(
          "student",
          "name email bankAccountHolderName bankName bankAccountNumber ifscCode"
        )
        .populate("task", "title budget status")
        .populate("bid", "quote amount");

      return res.json(payments);
    } catch (err) {
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
RELEASE PAYMENT
POST /api/admin/releasePayment/:id
=====================================
*/

router.post(
  "/releasePayment/:id",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      console.log("POST /api/admin/releasePayment", id);

      const payment = await Payment.findById(id);

      if (!payment) {
        return res.status(404).json({
          message: "Not found",
        });
      }

      if (payment.status !== "held") {
        return res.status(400).json({
          message: "Payment is not approved by client yet",
        });
      }

      payment.status = "completed";
      await payment.save();

      const student = await User.findById(payment.student);
      if (student) {
        const amt = payment.netToStudent || payment.amount || 0;

        student.wallet = (student.wallet || 0) + amt;
        student.pendingEarnings = Math.max(
          0,
          (student.pendingEarnings || 0) - amt
        );
        student.totalEarningsReleased =
          (student.totalEarningsReleased || 0) + amt;

        await student.save();
      }

      return res.json({
        message: "Payment released",
      });
    } catch (err) {
      console.error("Error in /api/admin/releasePayment/:id", err);
      return res.status(500).json({
        message: err.message,
      });
    }
  }
);

/*
=====================================
GROWTH STATS
GET /api/admin/stats/growth
=====================================
*/

router.get(
  "/stats/growth",
  verifyJWT,
  ensureAdmin,
  async (req, res) => {
    try {
      const {
        metric = "tasks",
        granularity = "month",
        from,
        to,
      } = req.query;

      const startDate = from ? new Date(from) : new Date("2024-01-01");
      const endDate = to ? new Date(to) : new Date();

      let model;
      const match = {
        createdAt: { $gte: startDate, $lte: endDate },
      };

      switch (metric) {
        case "users":
          model = User;
          break;
        case "students":
          model = User;
          match.role = "student";
          break;
        case "clients":
          model = User;
          match.role = "client";
          break;
        case "tasks":
          model = Task;
          break;
        case "bids":
          model = Bid;
          break;
        case "successfulBids":
          model = Bid;
          match.status = "accepted";
          break;
        case "completedPayments":
          model = Payment;
          match.status = "completed";
          break;
        default:
          return res.status(400).json({ message: "Invalid metric" });
      }

      const dateTrunc =
        granularity === "day"
          ? { $dateTrunc: { date: "$createdAt", unit: "day" } }
          : { $dateTrunc: { date: "$createdAt", unit: "month" } };

      const pipeline = [
        { $match: match },
        {
          $group: {
            _id: dateTrunc,
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ];

      const stats = await model.aggregate(pipeline);

      const mapped = stats.map((s) => ({
        bucket: s._id,
        count: s.count,
      }));

      return res.json(mapped);
    } catch (err) {
      console.error("Error in /api/admin/stats/growth", err);
      return res.status(500).json({
        message: "Error loading growth stats",
        error: err.message,
      });
    }
  }
);

module.exports = router;