// routes/students.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const User = require('../models/User');
const Payment = require('../models/Payment');
const verifyJWT = require('../middleware/authMiddleware');

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
          $sum: {
            $ifNull: ['$netToStudent', 0],
          },
        },
      },
    },
  ]);

  return result.length > 0 ? result[0].total : 0;
}

// GET /api/students/:id/public-profile
// Returns profile + ratings + payment stats based on Payment.netToStudent
router.get('/:id/public-profile', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid student id' });
    }

    const student = await User.findById(id).select(
      'name email bio skills portfolioUrl totalScore totalScoreCount feedbackScores role'
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
    const totalAverage =
      totalScoreCount > 0 ? totalScore / totalScoreCount : 0;

    const [pendingPayments, earnedPayments, acceptedQuoteTotal] =
      await Promise.all([
        sumNetToStudentByStatuses(id, ['held']),
        sumNetToStudentByStatuses(id, ['released']),
        sumNetToStudentByStatuses(id, ['held', 'released']),
      ]);

    return res.json({
      id: student._id,
      name: student.name || '',
      email: student.email || '',
      bio: student.bio || '',
      skills: Array.isArray(student.skills) ? student.skills : [],
      portfolioUrl: student.portfolioUrl || '',
      totalScore,
      totalScoreCount,
      totalAverageScore: totalAverage,
      domains,
      pendingPayments,
      earnedPayments,
      acceptedQuoteTotal,
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Error fetching student profile',
      error: err.message,
    });
  }
});

module.exports = router;