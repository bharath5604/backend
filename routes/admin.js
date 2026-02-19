const express = require('express');
const router = express.Router();

const User = require('../models/User');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const Bid = require('../models/Bid');

const verifyJWT = require('../middleware/authMiddleware');



/**
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



/**
=====================================
USERS
=====================================
*/

router.get('/users',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {

    try {

      const filter = {};

      if (req.query.role)
        filter.role = req.query.role;
      else
        filter.role = { $ne: 'admin' };


      const users =
        await User.find(filter)
          .select('-password');

      res.json(users);

    }
    catch (err) {

      res.status(500).json({
        message: err.message
      });

    }

  });




router.patch('/users/:id/approve',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {

    try {

      const user =
        await User.findByIdAndUpdate(
          req.params.id,
          { isApproved: req.body.isApproved },
          { new: true }
        ).select('-password');

      res.json(user);

    }
    catch (err) {

      res.status(500).json({
        message: err.message
      });

    }

  });





/**
=====================================
TASKS
=====================================
*/

router.get('/tasks',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {

    try {

      const tasks =
        await Task.find()
          .populate('client', 'name email')
          .populate('student', 'name email');

      res.json(tasks);

    }
    catch (err) {

      res.status(500).json({
        message: err.message
      });

    }

  });





/**
=====================================
PAYMENTS
=====================================
*/


// ALL PAYMENTS

router.get('/payments',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {

    try {

      const filter = {};

      if (req.query.status)
        filter.status = req.query.status;


      const payments =
        await Payment.find(filter)
          .populate('student', 'name email wallet')
          .populate('task', 'title budget')
          .populate('client', 'name email');

      res.json(payments);

    }
    catch (err) {

      res.status(500).json({
        message: err.message
      });

    }

  });





// UPDATE PAYMENT STATUS

router.patch('/payments/:paymentId/status',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {

    try {

      const payment =
        await Payment.findById(
          req.params.paymentId
        );

      if (!payment)
        return res.status(404).json({
          message: "Payment not found"
        });



      payment.status = req.body.status;

      payment.adminNote =
        req.body.adminNote || "";

      payment.releasedAt =
        new Date();


      await payment.save();



      // add money

      if (req.body.status === "released") {

        const student =
          await User.findById(
            payment.student
          );

        student.wallet += payment.amount;

        await student.save();

      }


      res.json(payment);

    }
    catch (err) {

      res.status(500).json({
        message: err.message
      });

    }

  });






/**
=====================================
MANUAL PAYMENT LIST
=====================================
*/


router.get('/manual-payments/pending',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {

    try {

      const payments =
        await Payment.find({
          status: 'held'
        })
          .populate('student', 'name email')
          .populate('task', 'title budget');

      res.json(payments);

    }
    catch (err) {

      res.status(500).json({
        message: err.message
      });

    }

  });







/**
=====================================
STUDENT DASHBOARD
=====================================
*/


router.get('/students/:studentId/dashboard',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {

    try {

      const student =
        await User.findById(
          req.params.studentId
        ).select('-password');


      const tasks =
        await Task.find({
          student: req.params.studentId
        });


      const payments =
        await Payment.find({
          student: req.params.studentId
        });


      res.json({

        student,
        tasks,
        payments

      });

    }
    catch (err) {

      res.status(500).json({
        message: err.message
      });

    }

  });






/**
=====================================
OVERVIEW STATS
=====================================
*/

router.get('/stats/overview',
  verifyJWT,
  ensureAdmin,
  async (req, res) => {

    try {

      res.json({

        totalUsers:
          await User.countDocuments(),

        totalStudents:
          await User.countDocuments({
            role: "student"
          }),

        totalTasks:
          await Task.countDocuments(),

        totalPayments:
          await Payment.countDocuments(),

      });

    }
    catch (err) {

      res.status(500).json({
        message: err.message
      });

    }

  });




module.exports = router;
