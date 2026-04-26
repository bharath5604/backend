// backend/routes/user.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Joi = require('joi');

const User = require('../models/User');
const Payment = require('../models/Payment');
const Withdrawal = require('../models/Withdrawal'); // NEW: Import the Withdrawal model
const verifyJWT = require('../middleware/authMiddleware');

// =========================================================
// JOI SCHEMAS (RESTORED & EXPANDED)
// =========================================================

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

const withdrawRequestSchema = Joi.object({
  amount: Joi.number().min(500).required(), // Enforce minimum withdrawal of ₹500
});

// =========================================================
// SHARED HELPERS (RESTORED)
// =========================================================

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

// =========================================================
// 1. AUTHENTICATED USER ROUTES
// =========================================================

/**
 * GET /api/users/me
 * RESTORED: Fetches private profile and aggregated earnings
 */
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
          sumNetToStudentByStatuses(user._id, ['held', 'approved']),
          // payments fully released to wallet
          sumNetToStudentByStatuses(user._id, ['completed', 'released']),
          // total assigned workload value
          sumNetToStudentByStatuses(user._id, ['held', 'approved', 'completed', 'released']),
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

/**
 * GET /api/users/me/payment-stats
 * RESTORED: Returns cashflow overview for the student dashboard
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
        { $match: { student: studentId, status: { $in: ['held', 'approved', 'completed', 'released'] } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$netToStudent', 0] } } } },
      ]),
      Payment.aggregate([
        { $match: { student: studentId, status: { $in: ['completed', 'released'] } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$netToStudent', 0] } } } },
      ]),
    ]);

    const totalAcceptedAmount = acceptedAgg.length > 0 ? acceptedAgg[0].total : 0;
    const totalReceivedAmount = receivedAgg.length > 0 ? receivedAgg[0].total : 0;
    const totalPendingAmount = totalAcceptedAmount - totalReceivedAmount;

    return res.json({
      totalAcceptedAmount,
      totalPendingAmount,
      totalReceivedAmount,
    });
  } catch (err) {
    console.error('Error in GET /api/users/me/payment-stats', err);
    return res.status(500).json({ message: 'Error computing student payment stats' });
  }
});

/**
 * PROFILE UPDATES
 * RESTORED: Shared logic for PUT/PATCH
 */
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
    delete updates.company; delete updates.location; delete updates.domain; delete updates.description;
  }

  try {
    const user = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
      runValidators: true,
    }).select('-password');

    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json({ message: 'Profile updated', user });
  } catch (err) {
    return res.status(400).json({ message: 'Error updating profile', error: err.message });
  }
}

router.put('/me', verifyJWT, applyProfileUpdate);
router.patch('/me', verifyJWT, applyProfileUpdate);

// =========================================================
// 2. NEW: WITHDRAWAL MODULE (STUDENT ACTION)
// =========================================================

/**
 * POST /api/users/withdraw
 * WORKFLOW: Student requests cashing out virtual wallet to real bank account
 */
router.post('/withdraw', verifyJWT, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can request withdrawals' });
    }

    const { error, value } = withdrawRequestSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const user = await User.findById(req.user.id).session(session);

    // 1. Logic: Check if virtual wallet has sufficient balance
    if (user.wallet < value.amount) {
      return res.status(400).json({ message: 'Insufficient balance in your virtual wallet' });
    }

    // 2. Logic: Ensure bank details exist for the transfer
    if (!user.bankAccountNumber || !user.ifscCode) {
      return res.status(400).json({ message: 'Please set your bank account details in your profile first' });
    }

    // 3. Logic: Create Withdrawal Request with a snapshot of current bank details
    const withdrawal = new Withdrawal({
      student: user._id,
      amount: value.amount,
      bankSnapshot: {
        accountHolderName: user.bankAccountHolderName,
        bankName: user.bankName,
        accountNumber: user.bankAccountNumber,
        ifscCode: user.ifscCode
      },
      status: 'pending'
    });

    // 4. Logic: Deduct money from virtual wallet immediately (to "Lock" the funds)
    user.wallet -= value.amount;

    await withdrawal.save({ session });
    await user.save({ session });

    await session.commitTransaction();
    return res.json({ message: 'Withdrawal request submitted successfully', newBalance: user.wallet });

  } catch (err) {
    await session.abortTransaction();
    console.error('Withdrawal Request Error:', err);
    return res.status(500).json({ message: 'Failed to process withdrawal request' });
  } finally {
    session.endSession();
  }
});

// =========================================================
// 3. PUBLIC PROFILES (RESTORED)
// =========================================================

router.get('/students/:id/public-profile', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid ID' });

    const student = await User.findById(id).select('name role bio skills portfolioUrl totalScore totalScoreCount feedbackScores');
    if (!student || student.role !== 'student') return res.status(404).json({ message: 'Student not found' });

    const domains = (student.feedbackScores || []).map((d) => {
      const ts = Number(d.totalScore || 0); const c = Number(d.count || 0);
      return { domain: d.domain || '', averageScore: c > 0 ? ts / c : 0, count: c };
    });

    return res.json({
      id: student._id, name: student.name, role: student.role, bio: student.bio,
      skills: student.skills, portfolioUrl: student.portfolioUrl,
      totalScore: student.totalScore, totalScoreCount: student.totalScoreCount,
      totalAverageScore: student.totalScoreCount > 0 ? student.totalScore / student.totalScoreCount : 0,
      domains
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching student profile' });
  }
});

router.get('/clients/:id/public-profile', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid ID' });

    const client = await User.findById(id).select('name role company location domain description');
    if (!client || client.role !== 'client') return res.status(404).json({ message: 'Client not found' });

    return res.json({
      id: client._id, name: client.name, role: client.role,
      company: client.company, location: client.location, domain: client.domain, description: client.description
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching client profile' });
  }
});

module.exports = router;