// routes/user.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const verifyJWT = require('../middleware/authMiddleware');
const Joi = require('joi');

// Joi schemas
const updateMeSchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  bio: Joi.string().max(1000).allow('', null),
  skills: Joi.array().items(Joi.string().max(100)).optional(),
  portfolioUrl: Joi.string().uri().max(500).allow('', null),

  // shared profile images
  avatarUrl: Joi.string().uri().max(500).allow('', null),
  bannerUrl: Joi.string().uri().max(500).allow('', null),

  // client-only fields
  company: Joi.string().max(200).allow('', null),
  location: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  description: Joi.string().max(1000).allow('', null),
});

// GET /api/users/me
router.get('/me', verifyJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error fetching profile', error: err.message });
  }
});

// internal helper to apply validated updates
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

  // If not client, ignore client-only fields
  if (req.user.role !== 'client') {
    delete updates.company;
    delete updates.location;
    delete updates.domain;
    delete updates.description;
    delete updates.bannerUrl;
  }

  try {
    const user = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
      runValidators: true,
    }).select('-password');

    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({ message: 'Profile updated', user });
  } catch (err) {
    res
      .status(400)
      .json({ message: 'Error updating profile', error: err.message });
  }
}

// PUT /api/users/me
router.put('/me', verifyJWT, async (req, res) => {
  await applyProfileUpdate(req, res);
});

// Optional: keep PATCH for backward compatibility
router.patch('/me', verifyJWT, async (req, res) => {
  await applyProfileUpdate(req, res);
});

// GET /api/students/:id/public-profile
router.get('/students/:id/public-profile', async (req, res) => {
  try {
    const student = await User.findById(req.params.id).select(
      'name role bio skills portfolioUrl totalScore totalScoreCount feedbackScores avatarUrl'
    );
    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    // compute per-domain averages
    const domains = (student.feedbackScores || []).map((d) => ({
      domain: d.domain,
      averageScore: d.count > 0 ? d.totalScore / d.count : 0,
      count: d.count,
    }));
    const totalAverageScore =
      student.totalScoreCount > 0
        ? student.totalScore / student.totalScoreCount
        : 0;

    res.json({
      id: student._id,
      name: student.name,
      role: student.role,
      bio: student.bio,
      skills: student.skills,
      portfolioUrl: student.portfolioUrl,
      avatarUrl: student.avatarUrl,
      totalScore: student.totalScore,
      totalScoreCount: student.totalScoreCount,
      totalAverageScore,
      domains,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching public profile',
      error: err.message,
    });
  }
});

// GET /api/clients/:id/public-profile
router.get('/clients/:id/public-profile', async (req, res) => {
  try {
    const client = await User.findById(req.params.id).select(
      'name role company location domain description avatarUrl bannerUrl'
    );
    if (!client || client.role !== 'client') {
      return res.status(404).json({ message: 'Client not found' });
    }

    res.json({
      id: client._id,
      name: client.name,
      role: client.role,
      company: client.company,
      location: client.location,
      domain: client.domain,
      description: client.description,
      avatarUrl: client.avatarUrl,
      bannerUrl: client.bannerUrl,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching public profile',
      error: err.message,
    });
  }
});

module.exports = router;
