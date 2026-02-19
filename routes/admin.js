const express = require('express');
const router = express.Router();

const User = require('../models/User');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const Bid = require('../models/Bid');

const verifyJWT = require('../middleware/authMiddleware');



/*
=====================================
ADMIN CHECK
=====================================
*/

const ensureAdmin = (req, res, next) => {

  if (!req.user || req.user.role !== 'admin') {

    return res.status(403).json({
      message: 'Admin only'
    });

  }

  next();

};


/*
=====================================
OVERVIEW STATS
/api/admin/stats/overview
=====================================
*/

router.get('/stats/overview',
verifyJWT,
ensureAdmin,
async (req, res) => {

  try {

    const totalUsers = await User.countDocuments();
    const totalStudents = await User.countDocuments({ role: "student" });
    const totalTasks = await Task.countDocuments();
    const totalPayments = await Payment.countDocuments();

    res.json({
      totalUsers,
      totalStudents,
      totalTasks,
      totalPayments
    });

  }

  catch (err) {

    res.status(500).json({
      message: err.message
    });

  }

});



/*
=====================================
TASK STATS
=====================================
*/

router.get('/getTaskStats', async (req, res) => {

  try {

    const total = await Task.countDocuments();

    const completed =
      await Task.countDocuments({
        status: "completed"
      });

    const pending =
      await Task.countDocuments({
        status: "pending"
      });

    res.json({

      total,
      completed,
      pending

    });

  }

  catch (err) {

    res.status(500).json({
      message: err.message
    });

  }

});



/*
=====================================
DOMAIN STATS
=====================================
*/

router.get('/getDomainStats', async (req, res) => {

  try {

    const stats =
      await Task.aggregate([

        {
          $group: {
            _id: "$domain",
            count: { $sum: 1 }
          }
        }

      ]);

    res.json(stats);

  }

  catch (err) {

    res.status(500).json({
      message: err.message
    });

  }

});



/*
=====================================
TOP STUDENTS
=====================================
*/

router.get('/getTopStudents', async (req, res) => {

  try {

    const stats =
      await Payment.aggregate([

        {
          $group: {

            _id: "$student",

            total:
              { $sum: "$amount" }

          }
        },

        { $sort: { total: -1 } },

        { $limit: 5 }

      ]);

    res.json(stats);

  }

  catch (err) {

    res.status(500).json({
      message: err.message
    });

  }

});



/*
=====================================
TIME SERIES
=====================================
*/

router.get('/getTimeSeriesStats', async (req, res) => {

  try {

    const stats =
      await Task.aggregate([

        {
          $group: {

            _id: {

              month:
                { $month: "$createdAt" }

            },

            count:
              { $sum: 1 }

          }

        }

      ]);

    res.json(stats);

  }

  catch (err) {

    res.status(500).json({
      message: err.message
    });

  }

});



/*
=====================================
TASK FUNNEL
=====================================
*/

router.get('/getTaskFunnelStats', async (req, res) => {

  try {

    const stats = {

      total:
        await Task.countDocuments(),

      assigned:
        await Task.countDocuments({
          student: { $ne: null }
        }),

      completed:
        await Task.countDocuments({
          status: "completed"
        })

    };

    res.json(stats);

  }

  catch (err) {

    res.status(500).json({
      message: err.message
    });

  }

});



/*
=====================================
PENDING PAYMENTS
=====================================
*/

router.get('/getPendingPayments', async (req, res) => {

  try {

    const payments =
      await Payment.find({
        status: "held"
      })

      .populate("student", "name email")
      .populate("task", "title budget");

    res.json(payments);

  }

  catch (err) {

    res.status(500).json({
      message: err.message
    });

  }

});



/*
=====================================
RELEASE PAYMENT
=====================================
*/

router.post('/releasePayment/:id', async (req, res) => {

  try {

    const payment =
      await Payment.findById(req.params.id);

    if (!payment)
      return res.status(404).json({
        message: "Not found"
      });



    payment.status = "released";

    await payment.save();



    const student =
      await User.findById(payment.student);

    student.wallet += payment.amount;

    await student.save();



    res.json({
      message: "Payment released"
    });

  }

  catch (err) {

    res.status(500).json({
      message: err.message
    });

  }

});



module.exports = router;
