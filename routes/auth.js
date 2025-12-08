const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');

// Joi schemas
const signupSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().max(200).required(),
  password: Joi.string().min(6).max(128).required(),
  role: Joi.string().valid('student', 'client', 'admin').required(),
  company: Joi.string().max(200).allow('', null),
  location: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  // For students: skills list used to filter task feed
  skills: Joi.array().items(Joi.string().max(100)).default([]),
});

const loginSchema = Joi.object({
  email: Joi.string().email().max(200).required(),
  password: Joi.string().min(6).max(128).required(),
});

// SIGNUP
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

    const {
      name,
      email,
      password,
      role,
      company,
      location,
      domain,
      skills,
    } = value;

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashed,
      role,
      // client-specific fields
      company: role === 'client' ? company : undefined,
      location: role === 'client' ? location : undefined,
      domain: role === 'client' ? domain : undefined,
      // student-specific fields
      skills: role === 'student' ? skills : [],
      // isApproved default from schema
    });

    console.log('New user created with skills:', user.skills); // debug

    const safeUser = await User.findById(user._id).select('-password');

    res.json({ message: 'User created', user: safeUser });
  } catch (err) {
    res
      .status(400)
      .json({ message: 'Error creating user', error: err.message });
  }
});

// LOGIN
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

    const { email, password } = value;

    const user = await User.findOne({ email });
    if (!user)
      return res.status(404).json({ message: 'User not found' });

    if (!user.isApproved) {
      return res
        .status(403)
        .json({ message: 'Account not approved by admin' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ message: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const safeUser = await User.findById(user._id).select('-password');

    res.json({ token, user: safeUser });
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Login error', error: err.message });
  }
});

module.exports = router;
