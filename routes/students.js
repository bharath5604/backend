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
 * Formats domain-specific reputation scores for the Flutter UI.
 * Rounds averages to 1 decimal place for visual consistency.
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
      averageScore: count > 0 ? (totalScore / count).toFixed(1) : "0.0",
    };
  });
}

// =========================================================
// ROUTES
// =========================================================

/**
 * GET /api/students/:id/public-profile
 * Logic: Returns full profile including Bio, Skills, and RECENT FEEDBACK.
 * This route is used by the Profile Tab in the Student App.
 */
router.get('/:id/public-profile', verifyJWT, async (req, res) => {
  try {
    const id = normalizeId(req.params.id);

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid student ID provided.' });
    }

    // Explicitly select feedbackEntries to populate the Profile history list
    const student = await User.findById(id).select(
      'name email skills location portfolioUrl totalScore totalScoreCount feedbackScores feedbackEntries role tasksCompleted'
    );

    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student profile not found.' });
    }

    const domains = mapFeedbackDomains(student.feedbackScores);
    const totalScore = toNumber(student.totalScore);
    const totalScoreCount = toNumber(student.totalScoreCount);
    const totalAverage = totalScoreCount > 0 ? (totalScore / totalScoreCount).toFixed(1) : "0.0";

    return res.json({
      id: student._id,
      name: clean(student.name),
      email: clean(student.email),
      // bio: clean(student.bio),
      location: clean(student.location),
      skills: Array.isArray(student.skills) ? student.skills : [],
      portfolioUrl: clean(student.portfolioUrl),
      tasksCompleted: toNumber(student.tasksCompleted), // Ensure count is sent to UI
      totalScore,
      totalScoreCount,
      totalAverageScore: totalAverage,
      domains: domains,
      feedbackEntries: student.feedbackEntries || [] // Fix: Included history list
    });

  } catch (err) {
    console.error('Error in GET /public-profile:', err.message);
    return res.status(500).json({
      message: 'Failed to retrieve student profile.',
    });
  }
});

/**
 * GET /api/students/:id/feedback-summary
 * Logic: Returns statistical breakdown and RECENT CLIENT FEEDBACK.
 * This route is used by the Earnings & Feedback Tab in the Student App.
 */
router.get('/:id/feedback-summary', verifyJWT, async (req, res) => {
  try {
    const student = await User.findById(req.params.id)
      .select('totalScore totalScoreCount feedbackScores feedbackEntries role');

    if (!student) return res.status(404).json({ message: 'Student not found' });

    return res.json({
      studentId: student._id,
      totalScore: student.totalScore,
      totalScoreCount: student.totalScoreCount,
      averageScore: student.totalScoreCount > 0 ? (student.totalScore / student.totalScoreCount).toFixed(1) : 0,
      domains: student.feedbackScores || [],
      feedbackEntries: student.feedbackEntries || [] // Send the list of reviews
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;