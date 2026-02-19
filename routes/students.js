// routes/students.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Payment = require('../models/Payment');
const verifyJWT = require('../middleware/authMiddleware');

// GET /api/students/:id/public-profile
// Returns profile + ratings + payment stats based on Payment.netToStudent
router.get('/:id/public-profile', verifyJWT, async (req, res) => {
  try {
    const student = await User.findById(req.params.id).select(
      'name email bio skills portfolioUrl totalScore totalScoreCount feedbackScores role'
    );

    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Per-domain feedback stats
    const domains = (student.feedbackScores || []).map((d) => ({
      domain: d.domain,
      averageScore: d.count > 0 ? d.totalScore / d.count : 0,
      count: d.count,
    }));

    // Overall average rating
    const totalAverage =
      (student.totalScoreCount || 0) > 0
        ? (student.totalScore || 0) / student.totalScoreCount
        : 0;

    // Payment aggregates for this student (all in terms of netToStudent, i.e., student bid amount)
    const [pendingAgg, earnedAgg, acceptedAgg] = await Promise.all([
      // Pending (held) amount: admin has not yet released
      Payment.aggregate([
        {
          $match: {
            student: student._id,
            status: 'held',
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$netToStudent' },
          },
        },
      ]),
      // Earned (released) amount: already released by admin
      Payment.aggregate([
        {
          $match: {
            student: student._id,
            status: 'released',
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$netToStudent' },
          },
        },
      ]),
      // Accepted quotes = all bids that got a Payment record
      // (both held + released)
      Payment.aggregate([
        {
          $match: {
            student: student._id,
            status: { $in: ['held', 'released'] },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$netToStudent' },
          },
        },
      ]),
    ]);

    const pendingPayments =
      pendingAgg.length > 0 ? pendingAgg[0].total : 0;
    const earnedPayments =
      earnedAgg.length > 0 ? earnedAgg[0].total : 0;
    const acceptedQuoteTotal =
      acceptedAgg.length > 0 ? acceptedAgg[0].total : 0;

    res.json({
      id: student._id,
      name: student.name,
      email: student.email,
      bio: student.bio || '',
      skills: student.skills || [],
      portfolioUrl: student.portfolioUrl || '',
      totalScore: student.totalScore || 0,
      totalScoreCount: student.totalScoreCount || 0,
      totalAverageScore: totalAverage,
      domains,
      // sums of student-side amounts (their bid, not client proposal)
      pendingPayments,      // sum netToStudent where status = 'held'
      earnedPayments,       // sum netToStudent where status = 'released'
      acceptedQuoteTotal,   // sum netToStudent where status in ['held','released']
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching student profile',
      error: err.message,
    });
  }
});

module.exports = router;
