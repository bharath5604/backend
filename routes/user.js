// routes/user.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Joi = require('joi');

const User = require('../models/User');
const Payment = require('../models/Payment');
const verifyJWT = require('../middleware/authMiddleware');

// Joi schemas
const updateMeSchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  bio: Joi.string().max(1000).allow('', null),
  skills: Joi.array().items(Joi.string().max(100)).optional(),
  portfolioUrl: Joi.string().uri().max(500).allow('', null),

  // client-only fields
  company: Joi.string().max(200).allow('', null),
  location: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  description: Joi.string().max(1000).allow('', null),

  // optional bank fields for students
  bankAccountHolderName: Joi.string().max(200).allow('', null),
  bankName: Joi.string().max(200).allow('', null),
  bankAccountNumber: Joi.string().max(50).allow('', null),
  ifscCode: Joi.string().max(50).allow('', null),
});

// ---------- Shared helpers ----------

async function sumNetToStudentByStatuses(studentId, statuses) {
  const result = await Payment.aggregate([
    {
      $match: {
        student: new mongoose.Types.ObjectId(studentId),
        status: { $in: statuses },
      },
    },
    {
      $group: {
        _id: null,
        total: {
          $sum: { $ifNull: ['$netToStudent', 0] },
        },
      },
    },
  ]);

  return result.length > 0 ? result[0].total : 0;
}

// ---------- GET /api/users/me ----------

router.get('/me', verifyJWT, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.user.id)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.role === 'student') {
      const [pendingPayments, earnedPayments, acceptedQuoteTotal] =
        await Promise.all([
          // payments approved by client, waiting for admin release
          sumNetToStudentByStatuses(user._id, ['held']),
          // payments fully released to wallet
          sumNetToStudentByStatuses(user._id, ['completed']),
          // all accepted for this student (pending + completed)
          sumNetToStudentByStatuses(user._id, ['held', 'completed']),
        ]);

      const userObj = user.toObject();
      userObj.pendingPayments = pendingPayments;
      userObj.earnedPayments = earnedPayments;
      userObj.acceptedQuoteTotal = acceptedQuoteTotal;

      return res.json(userObj);
    }

    return res.json(user);
  } catch (err) {
    return res
      .status(500)
      .json({ message: 'Error fetching profile', error: err.message });
  }
});

/*
=====================================
PAYMENT-ONLY STATS FOR STUDENT
GET /api/users/me/payment-stats

- totalAcceptedAmount  => sum netToStudent where status in ['held','completed']
- totalReceivedAmount  => sum netToStudent where status = 'completed'
- totalPendingAmount   => accepted - received
=====================================
*/
router.get('/me/payment-stats', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const studentId = new mongoose.Types.ObjectId(userId);

    const [acceptedAgg, receivedAgg] = await Promise.all([
      Payment.aggregate([
        {
          $match: {
            student: studentId,
            status: { $in: ['held', 'completed'] },
          },
        },
        {
          $group: {
            _id: null,
            totalAcceptedAmount: {
              $sum: { $ifNull: ['$netToStudent', 0] },
            },
          },
        },
      ]),
      Payment.aggregate([
        {
          $match: {
            student: studentId,
            status: 'completed',
          },
        },
        {
          $group: {
            _id: null,
            totalReceivedAmount: {
              $sum: { $ifNull: ['$netToStudent', 0] },
            },
          },
        },
      ]),
    ]);

    const totalAcceptedAmount =
      acceptedAgg.length > 0 ? acceptedAgg[0].totalAcceptedAmount : 0;
    const totalReceivedAmount =
      receivedAgg.length > 0 ? receivedAgg[0].totalReceivedAmount : 0;
    const totalPendingAmount = totalAcceptedAmount - totalReceivedAmount;

    return res.json({
      totalAcceptedAmount,
      totalPendingAmount,
      totalReceivedAmount,
    });
  } catch (err) {
    console.error('Error in GET /api/users/me/payment-stats', err);
    return res.status(500).json({
      message: 'Error computing student payment stats',
      error: err.message,
    });
  }
});

// ---------- internal helper to apply validated updates ----------

async function applyProfileUpdate(req, res) {
  const { error, value } = updateMeSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    return res.status(400).json({
      message: 'Validation error',
      details: error.details.map((d) => d.message),
    });
  }

  const updates = { ...value };

  if (req.user.role !== 'client') {
    delete updates.company;
    delete updates.location;
    delete updates.domain;
    delete updates.description;
  }

  try {
    const user = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
      runValidators: true,
    }).select('-password');

    if (!user) return res.status(404).json({ message: 'User not found' });

    return res.json({ message: 'Profile updated', user });
  } catch (err) {
    return res
      .status(400)
      .json({ message: 'Error updating profile', error: err.message });
  }
}

// PUT /api/users/me
router.put('/me', verifyJWT, async (req, res) => {
  await applyProfileUpdate(req, res);
});

// PATCH /api/users/me (backward compatibility)
router.patch('/me', verifyJWT, async (req, res) => {
  await applyProfileUpdate(req, res);
});

// ---------- GET /api/students/:id/public-profile ----------

router.get('/students/:id/public-profile', async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid student id' });
    }

    const student = await User.findById(id).select(
      'name role bio skills portfolioUrl totalScore totalScoreCount feedbackScores'
    );

    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const domains = (student.feedbackScores || []).map((d) => {
      const totalScore = Number(d.totalScore || 0);
      const count = Number(d.count || 0);

      return {
        domain: d.domain || '',
        averageScore: count > 0 ? totalScore / count : 0,
        count,
      };
    });

    const totalScore = Number(student.totalScore || 0);
    const totalScoreCount = Number(student.totalScoreCount || 0);
    const totalAverageScore =
      totalScoreCount > 0 ? totalScore / totalScoreCount : 0;

    return res.json({
      id: student._id,
      name: student.name || '',
      role: student.role,
      bio: student.bio || '',
      skills: Array.isArray(student.skills) ? student.skills : [],
      portfolioUrl: student.portfolioUrl || '',
      totalScore,
      totalScoreCount,
      totalAverageScore,
      domains,
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Error fetching public profile',
      error: err.message,
    });
  }
});

// ---------- GET /api/clients/:id/public-profile ----------

router.get('/clients/:id/public-profile', async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid client id' });
    }

    const client = await User.findById(id).select(
      'name role company location domain description'
    );

    if (!client || client.role !== 'client') {
      return res.status(404).json({ message: 'Client not found' });
    }

    return res.json({
      id: client._id,
      name: client.name || '',
      role: client.role,
      company: client.company || '',
      location: client.location || '',
      domain: client.domain || '',
      description: client.description || '',
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Error fetching public profile',
      error: err.message,
    });
  }
});

module.exports = router;