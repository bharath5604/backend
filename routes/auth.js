// backend/routes/auth.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const nodemailer = require('nodemailer'); // Added for Email
const verifyJWT = require('../middleware/authMiddleware');

// =========================================================
// EMAIL CONFIGURATION
// =========================================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'krrinnovations@gmail.com',
    pass: process.env.GMAIL_APP_PASSWORD, // Must be a 16-character App Password
  },
});

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
  company: Joi.string().max(200).allow('', null),
  location: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  skills: Joi.array().items(Joi.string().max(100)).default([]),
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

// NEW: Password Reset Schemas
const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
});

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().length(6).required(),
  newPassword: Joi.string().min(6).max(128).required(),
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
      userPayload.company = clean(value.company) || '';
      userPayload.location = clean(value.location) || '';
      userPayload.domain = clean(value.domain) || '';
    }

    if (role === 'student') {
      userPayload.skills = [...new Set(value.skills || [])];
      userPayload.bankAccountHolderName = clean(value.bankAccountHolderName) || '';
      userPayload.bankName = clean(value.bankName) || '';
      userPayload.bankAccountNumber = clean(value.bankAccountNumber) || '';
      userPayload.ifscCode = clean(value.ifscCode) || '';
    }

    const user = await User.create(userPayload);
    const safeUser = await User.findById(user._id).select('-password');

    return res.status(201).json({ message: 'User created', user: safeUser });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ message: 'Error creating user', error: err.message });
  }
});

////////////////////////////////////////////////////////////
/// LOGIN
////////////////////////////////////////////////////////////

router.post('/login', async (req, res) => {
  try {
    const { error, value } = loginSchema.validate(req.body, { stripUnknown: true });

    if (error) {
      return res.status(400).json({ message: 'Validation error', details: error.details.map((d) => d.message) });
    }

    const email = clean(value.email).toLowerCase();
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (!user.isApproved) {
      return res.status(403).json({ message: 'Account not approved by admin' });
    }

    const match = await bcrypt.compare(value.password, user.password);
    if (!match) return res.status(401).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const safeUser = await User.findById(user._id).select('-password');

    return res.json({ token, user: safeUser });
  } catch (err) {
    return res.status(500).json({ message: 'Login error', error: err.message });
  }
});

////////////////////////////////////////////////////////////
/// FORGOT PASSWORD (NEW)
////////////////////////////////////////////////////////////

router.post('/forgot-password', async (req, res) => {
  try {
    const { error, value } = forgotPasswordSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const email = value.email.toLowerCase();
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "No account found with this email." });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Save to user with 10-minute expiry
    user.resetPasswordOTP = otp;
    user.resetPasswordExpires = Date.now() + 600000; 
    await user.save();

    // Send the email
    await transporter.sendMail({
      from: '"SKILEN Support" <krrinnovations@gmail.com>',
      to: email,
      subject: 'Your Password Reset Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee;">
          <h2 style="color: #E53935;">Password Reset Request</h2>
          <p>Hello ${user.name},</p>
          <p>You requested to reset your password. Use the code below to proceed:</p>
          <div style="background: #f4f4f4; padding: 15px; font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 5px;">
            ${otp}
          </div>
          <p>This code is valid for 10 minutes. If you did not request this, please ignore this email.</p>
          <br>
          <p>Regards,<br>SKILEN Team</p>
        </div>
      `,
    });

    return res.json({ success: true, message: "OTP sent to your email address." });

  } catch (err) {
    console.error('Forgot Password error:', err);
    return res.status(500).json({ message: "Failed to send OTP", error: err.message });
  }
});

////////////////////////////////////////////////////////////
/// RESET PASSWORD (NEW)
////////////////////////////////////////////////////////////

router.post('/reset-password', async (req, res) => {
  try {
    const { error, value } = resetPasswordSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const email = value.email.toLowerCase();
    const user = await User.findOne({ 
      email, 
      resetPasswordOTP: value.otp,
      resetPasswordExpires: { $gt: Date.now() } 
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired OTP code." });
    }

    // Update password
    user.password = await bcrypt.hash(value.newPassword, 10);
    
    // Clear reset fields
    user.resetPasswordOTP = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.json({ success: true, message: "Password updated successfully. You can now login." });

  } catch (err) {
    console.error('Reset Password error:', err);
    return res.status(500).json({ message: "Failed to reset password", error: err.message });
  }
});

////////////////////////////////////////////////////////////
/// REGISTER FCM TOKEN
////////////////////////////////////////////////////////////

router.post('/register-fcm', verifyJWT, async (req, res) => {
  try {
    const { error, value } = registerFcmSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ message: 'Validation error' });

    await User.findByIdAndUpdate(req.user.id, { fcmToken: clean(value.fcmToken) }, { new: true });
    return res.json({ message: 'FCM token registered' });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to register FCM token', error: err.message });
  }
});

module.exports = router;