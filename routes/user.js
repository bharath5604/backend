// backend/routes/user.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Joi = require('joi');

const User = require('../models/User');
const verifyJWT = require('../middleware/authMiddleware');

// =========================================================
// JOI SCHEMAS
// =========================================================

const updateMeSchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  bio: Joi.string().max(1000).allow('', null),
  skills: Joi.array().items(Joi.string().max(100)).optional(),
  portfolioUrl: Joi.string().uri().max(500).allow('', null),
  location: Joi.string().max(200).allow('', null), // Used by both roles now

  // client-only fields
  company: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  description: Joi.string().max(1000).allow('', null),

  // bank fields (kept for admin visibility)
  bankAccountHolderName: Joi.string().max(200).allow('', null),
  bankName: Joi.string().max(200).allow('', null),
  bankAccountNumber: Joi.string().max(50).allow('', null),
  ifscCode: Joi.string().max(50).allow('', null),
});

// =========================================================
// 1. AUTHENTICATED USER ROUTES
// =========================================================

/**
 * GET /api/users/me
 * FIXED: Removed all Payment/Wallet aggregation logic to prevent 500 error.
 */
router.get('/me', verifyJWT, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.user.id)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Returns profile data only (Reputation, Skills, Location, etc.)
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching profile', error: err.message });
  }
});

/**
 * PROFILE UPDATES
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

  // Safety: Prevent non-clients from setting company fields
  const updates = { ...value };
  if (req.user.role !== 'client') {
    delete updates.company; 
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
    return res.status(400).json({ message: 'Error updating profile', error: err.message });
  }
}

router.put('/me', verifyJWT, applyProfileUpdate);
router.patch('/me', verifyJWT, applyProfileUpdate);

// =========================================================
// 2. PUBLIC PROFILES (Reputation Only)
// =========================================================

/**
 * GET /api/users/students/:id/public-profile
 * FIXED: Removed payment logic to prevent 500 error.
 */
router.get('/students/:id/public-profile', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid ID' });

    const student = await User.findById(id).select(
      'name role bio skills location portfolioUrl tasksCompleted totalScore totalScoreCount feedbackScores'
    );

    if (!student || student.role !== 'student') return res.status(404).json({ message: 'Student not found' });

    return res.json(student);
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching student profile' });
  }
});

/**
 * GET /api/users/clients/:id/public-profile
 */
router.get('/clients/:id/public-profile', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid ID' });

    const client = await User.findById(id).select('name role company location domain description');
    if (!client || client.role !== 'client') return res.status(404).json({ message: 'Client not found' });

    return res.json(client);
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching client profile' });
  }
});

module.exports = router;