// backend/routes/students.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const User = require('../models/User');
const verifyJWT = require('../middleware/authMiddleware');

// =========================================================
// HELPERS
// =========================================================

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

function toNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Formats domain-specific reputation scores for the UI
 */
function mapFeedbackDomains(feedbackScores) {
  if (!Array.isArray(feedbackScores)) return [];

  return feedbackScores.map((d) => {
    const totalScore = toNumber(d?.totalScore);
    const count = toNumber(d?.count);

    return {
      domain: clean(d?.domain),
      totalScore,
      count,
      averageScore: count > 0 ? (totalScore / count).toFixed(2) : 0,
    };
  });
}

// =========================================================
// ROUTES
// =========================================================

/**
 * GET /api/students/:id/public-profile
 * FIXED: Removed all Payment model logic to resolve 500 Internal Server Error.
 */
router.get('/:id/public-profile', verifyJWT, async (req, res) => {
  try {
    const id = normalizeId(req.params.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid student id' });
    }

    // Selecting only reputation and bio fields
    const student = await User.findById(id).select(
      'name email bio skills location portfolioUrl totalScore totalScoreCount feedbackScores role tasksCompleted'
    );

    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Process reputation metrics
    const domains = mapFeedbackDomains(student.feedbackScores);
    const totalScore = toNumber(student.totalScore);
    const totalScoreCount = toNumber(student.totalScoreCount);
    const totalAverage = totalScoreCount > 0 ? (totalScore / totalScoreCount).toFixed(2) : 0;

    return res.json({
      id: student._id,
      name: clean(student.name),
      email: clean(student.email),
      bio: clean(student.bio),
      location: clean(student.location),
      skills: Array.isArray(student.skills) ? student.skills : [],
      portfolioUrl: clean(student.portfolioUrl),
      tasksCompleted: toNumber(student.tasksCompleted),
      totalScore,
      totalScoreCount,
      totalAverageScore: totalAverage,
      domains: domains, // Technical domain breakdown
    });

  } catch (err) {
    console.error('Error in GET /api/students/:id/public-profile:', err.message);
    return res.status(500).json({
      message: 'Error fetching student profile. Database aggregation failed.',
    });
  }
});

/**
 * GET /api/students/:id/feedback-summary
 */
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
    const averageScore = totalScoreCount > 0 ? (totalScore / totalScoreCount).toFixed(2) : 0;

    const domains = mapFeedbackDomains(student.feedbackScores);

    return res.json({
      studentId: student._id,
      totalScore,
      totalScoreCount,
      averageScore,
      domains,
    });
  } catch (err) {
    console.error('Error in GET /api/students/:id/feedback-summary:', err.message);
    return res.status(500).json({
      message: 'Error fetching feedback summary',
    });
  }
});

module.exports = router;