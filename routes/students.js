// routes/students.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const verifyJWT = require('../middleware/authMiddleware');

// GET /api/students/:id/public-profile
router.get('/:id/public-profile', verifyJWT, async (req, res) => {
  try {
    const student = await User.findById(req.params.id).select(
      'name email bio skills portfolioUrl totalScore totalScoreCount feedbackScores role'
    );

    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const domains = (student.feedbackScores || []).map((d) => ({
      domain: d.domain,
      averageScore: d.count > 0 ? d.totalScore / d.count : 0,
      count: d.count,
    }));

    const totalAverage =
      (student.totalScoreCount || 0) > 0
        ? (student.totalScore || 0) / student.totalScoreCount
        : 0;

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
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error fetching student profile', error: err.message });
  }
});

module.exports = router;
