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

/**
 * Validation schema for profile updates.
 * Requirement: Students must be able to edit all details including bank info.
 */
const updateMeSchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  email: Joi.string().email().max(200).optional(), // Optional email change support
  mobile: Joi.string().max(20).allow('', null),    // Requirement: Edit contact
  // bio: Joi.string().max(1000).allow('', null),
  skills: Joi.array().items(Joi.string().max(100)).optional(),
  portfolioUrl: Joi.string().uri().max(500).allow('', null),
  location: Joi.string().max(200).allow('', null), // Fixed location storage

  // Client-specific business fields
  company: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  description: Joi.string().max(1000).allow('', null),

  // Requirement: Full bank detail editability for students
  bankAccountHolderName: Joi.string().max(200).allow('', null),
  bankAccountNumber: Joi.string().max(50).allow('', null),
  ifscCode: Joi.string().max(50).allow('', null),
});

// =========================================================
// 1. AUTHENTICATED USER ROUTES
// =========================================================

/**
 * GET /api/users/me
 * Logic: Returns the private profile of the logged-in user.
 * Included: All details, reputation metrics, and feedback history.
 */
router.get('/me', verifyJWT, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.user.id)) {
      return res.status(400).json({ message: 'Invalid session ID' });
    }

    // select('-password') retrieves every field in the User model except the hash
    const user = await User.findById(req.user.id).select('-password');
    
    if (!user) return res.status(404).json({ message: 'User profile not found' });

    return res.json(user);
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching profile data', error: err.message });
  }
});

/**
 * PROFILE UPDATES (PUT/PATCH)
 * Requirement: Logic to handle full profile editing including bank info.
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
  
  // Logic: Prevent Students/Admins from hijacking Client business profiles
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
    
    return res.json({ 
        message: 'Profile updated successfully', 
        user 
    });
  } catch (err) {
    return res.status(400).json({ 
        message: 'Failed to save profile changes', 
        error: err.message 
    });
  }
}

router.put('/me', verifyJWT, applyProfileUpdate);
router.patch('/me', verifyJWT, applyProfileUpdate);

// =========================================================
// 2. PUBLIC PROFILES
// =========================================================

/**
 * GET /api/users/students/:id/public-profile
 * Logic: Used by Admins/Clients to view student credentials.
 */
router.get('/students/:id/public-profile', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid ID' });

    const student = await User.findById(id).select(
        'name role skills location portfolioUrl tasksCompleted totalScore totalScoreCount feedbackScores feedbackEntries mobile'
    );

    if (!student || student.role !== 'student') {
        return res.status(404).json({ message: 'Student not found' });
    }

    return res.json(student);
  } catch (err) {
    return res.status(500).json({ message: 'Error retrieving public profile' });
  }
});

/**
 * GET /api/users/clients/:id/public-profile
 */
router.get('/clients/:id/public-profile', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid ID' });

    const client = await User.findById(id).select('name role company location domain description mobile');
    if (!client || client.role !== 'client') return res.status(404).json({ message: 'Client not found' });

    return res.json(client);
  } catch (err) {
    return res.status(500).json({ message: 'Error retrieving client profile' });
  }
});

module.exports = router;