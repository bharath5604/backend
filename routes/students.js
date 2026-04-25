// backend/routes/students.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const User = require('../models/User');
const Payment = require('../models/Payment');
const verifyJWT = require('../middleware/authMiddleware');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeId(value) {
  return clean(value);
}

function isValidObjectId(value) {
  const id = normalizeId(value);
  return /^[a-fA-F0-9]{24}$/.test(id);
}

function toObjectId(value) {
  return new mongoose.Types.ObjectId(normalizeId(value));
}

function toNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function mapFeedbackDomains(feedbackScores) {
  if (!Array.isArray(feedbackScores)) return [];

  return feedbackScores.map((d) => {
    const totalScore = toNumber(d?.totalScore);
    const count = toNumber(d?.count);

    return {
      domain: clean(d?.domain),
      totalScore,
      count,
      averageScore: count > 0 ? totalScore / count : 0,
    };
  });
}

async function sumNetToStudentByStatuses(studentId, statuses) {
  const objectId = toObjectId(studentId);

  const result = await Payment.aggregate([
    {
      $match: {
        student: objectId,
        status: { $in: statuses },
      },
    },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $ifNull: ['$netToStudent', 0],
          },
        },
      },
    },
  ]);

  return result.length > 0 ? toNumber(result[0].total) : 0;
}

// GET /api/students/:id/public-profile
// Returns profile + ratings + payment stats based on Payment.netToStudent
router.get('/:id/public-profile', verifyJWT, async (req, res) => {
  try {
    const id = normalizeId(req.params.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid student id' });
    }

    const student = await User.findById(id).select(
      'name email bio skills portfolioUrl totalScore totalScoreCount feedbackScores role'
    );

    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const domains = mapFeedbackDomains(student.feedbackScores).map((d) => ({
      domain: d.domain,
      averageScore: d.averageScore,
      count: d.count,
    }));

    const totalScore = toNumber(student.totalScore);
    const totalScoreCount = toNumber(student.totalScoreCount);
    const totalAverage = totalScoreCount > 0 ? totalScore / totalScoreCount : 0;

    const [pendingPayments, earnedPayments, acceptedQuoteTotal] =
      await Promise.all([
        sumNetToStudentByStatuses(id, ['held']),
        sumNetToStudentByStatuses(id, ['completed']),
        sumNetToStudentByStatuses(id, ['held', 'completed']),
      ]);

    return res.json({
      id: student._id,
      name: clean(student.name),
      email: clean(student.email),
      bio: clean(student.bio),
      skills: Array.isArray(student.skills) ? student.skills : [],
      portfolioUrl: clean(student.portfolioUrl),
      totalScore,
      totalScoreCount,
      totalAverageScore: totalAverage,
      domains,
      pendingPayments,
      earnedPayments,
      acceptedQuoteTotal,
    });
  } catch (err) {
    console.error('Error in GET /api/students/:id/public-profile', err);
    return res.status(500).json({
      message: 'Error fetching student profile',
      error: err.message,
    });
  }
});

// GET /api/students/:id/feedback-summary
router.get('/:id/feedback-summary', verifyJWT, async (req, res) => {
  try {
    const id = normalizeId(req.params.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid student id' });
    }

    const student = await User.findById(id).select(
      'totalScore totalScoreCount feedbackScores role'
    );

    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const totalScore = toNumber(student.totalScore);
    const totalScoreCount = toNumber(student.totalScoreCount);
    const averageScore = totalScoreCount > 0 ? totalScore / totalScoreCount : 0;

    const domains = mapFeedbackDomains(student.feedbackScores);

    return res.json({
      studentId: student._id,
      totalScore,
      totalScoreCount,
      averageScore,
      domains,
    });
  } catch (err) {
    console.error('Error in GET /api/students/:id/feedback-summary', err);
    return res.status(500).json({
      message: 'Error fetching feedback summary',
      error: err.message,
    });
  }
});

module.exports = router;