//backend/routes/auth.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const verifyJWT = require('../middleware/authMiddleware');

////////////////////////////////////////////////////////////
/// Helpers
////////////////////////////////////////////////////////////

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

////////////////////////////////////////////////////////////
/// Joi schemas
////////////////////////////////////////////////////////////

const signupSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().max(200).required(),
  password: Joi.string().min(6).max(128).required(),
  role: Joi.string().valid('student', 'client', 'admin').required(),

  // client fields
  company: Joi.string().max(200).allow('', null),
  location: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),

  // student fields
  skills: Joi.array().items(Joi.string().max(100)).default([]),

  // bank details
  bankAccountHolderName: Joi.string().max(200).allow('', null),
  bankName: Joi.string().max(200).allow('', null),
  bankAccountNumber: Joi.string().max(50).allow('', null),
  ifscCode: Joi.string().max(50).allow('', null),
});

const loginSchema = Joi.object({
  email: Joi.string().email().max(200).required(),
  password: Joi.string().min(6).max(128).required(),
});

const registerFcmSchema = Joi.object({
  fcmToken: Joi.string().max(1000).required(),
});

////////////////////////////////////////////////////////////
/// SIGNUP
////////////////////////////////////////////////////////////

router.post('/signup', async (req, res) => {
  try {
    const { error, value } = signupSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const name = clean(value.name);
    const email = clean(value.email).toLowerCase();
    const password = value.password;
    const role = value.role;

    const company = clean(value.company);
    const location = clean(value.location);
    const domain = clean(value.domain);

    const skills = Array.isArray(value.skills)
      ? value.skills
          .map((skill) => clean(skill))
          .filter(Boolean)
      : [];

    const bankAccountHolderName = clean(value.bankAccountHolderName);
    const bankName = clean(value.bankName);
    const bankAccountNumber = clean(value.bankAccountNumber);
    const ifscCode = clean(value.ifscCode);

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, 10);

    const userPayload = {
      name,
      email,
      password: hashed,
      role,
    };

    if (role === 'client') {
      userPayload.company = company || '';
      userPayload.location = location || '';
      userPayload.domain = domain || '';
    }

    if (role === 'student') {
      userPayload.skills = [...new Set(skills)];
      userPayload.bankAccountHolderName = bankAccountHolderName || '';
      userPayload.bankName = bankName || '';
      userPayload.bankAccountNumber = bankAccountNumber || '';
      userPayload.ifscCode = ifscCode || '';
    }

    const user = await User.create(userPayload);

    const safeUser = await User.findById(user._id).select('-password');

    return res.status(201).json({
      message: 'User created',
      user: safeUser,
    });
  } catch (err) {
    console.error('Error in POST /api/auth/signup', err);
    return res.status(500).json({
      message: 'Error creating user',
      error: err.message,
    });
  }
});

////////////////////////////////////////////////////////////
/// LOGIN
////////////////////////////////////////////////////////////

router.post('/login', async (req, res) => {
  try {
    const { error, value } = loginSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const email = clean(value.email).toLowerCase();
    const password = value.password;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.isApproved) {
      return res.status(403).json({
        message: 'Account not approved by admin',
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const safeUser = await User.findById(user._id).select('-password');

    return res.json({
      token,
      user: safeUser,
    });
  } catch (err) {
    console.error('Error in POST /api/auth/login', err);
    return res.status(500).json({
      message: 'Login error',
      error: err.message,
    });
  }
});

////////////////////////////////////////////////////////////
/// REGISTER / UPDATE FCM TOKEN
/// POST /api/auth/register-fcm { fcmToken }
////////////////////////////////////////////////////////////

router.post('/register-fcm', verifyJWT, async (req, res) => {
  try {
    const { error, value } = registerFcmSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const fcmToken = clean(value.fcmToken);

    await User.findByIdAndUpdate(
      req.user.id,
      { fcmToken },
      { new: true, runValidators: true }
    );

    return res.json({ message: 'FCM token registered' });
  } catch (err) {
    console.error('register-fcm error:', err.message);
    return res.status(500).json({
      message: 'Failed to register FCM token',
      error: err.message,
    });
  }
});

module.exports = router;