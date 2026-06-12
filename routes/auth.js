// backend/routes/auth.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Task = require('../models/Task'); // Logic added to handle guest task claiming
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const nodemailer = require('nodemailer');
const verifyJWT = require('../middleware/authMiddleware');

// =========================================================
// EMAIL CONFIGURATION
// =========================================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'krrinnovations@gmail.com',
    pass: process.env.GMAIL_APP_PASSWORD, 
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
  mobile: Joi.string().min(10).max(15).required(),
  password: Joi.string().min(6).max(128).required(),
  role: Joi.string().valid('student', 'client', 'admin').required(),
  location: Joi.string().max(200).allow('', null), // Used for all roles
  company: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  skills: Joi.array().items(Joi.string().max(100)).default([]),
  bankAccountHolderName: Joi.string().max(200).allow('', null),
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

    const email = clean(value.email).toLowerCase();
    const mobile = clean(value.mobile);
    const location = clean(value.location);

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(value.password, 10);

    // Assembly of the user object
    const userPayload = {
      name: clean(value.name),
      email,
      mobile,
      password: hashed,
      role: value.role,
      location: location || '', // FIX: Explicitly ensuring location is stored for Students and Clients
    };

    // Role-specific field assignment
    if (value.role === 'client') {
      userPayload.company = clean(value.company) || '';
      userPayload.domain = clean(value.domain) || '';
    }

    if (value.role === 'student') {
      userPayload.skills = [...new Set(value.skills || [])];
      userPayload.bankAccountHolderName = clean(value.bankAccountHolderName) || '';
      userPayload.bankAccountNumber = clean(value.bankAccountNumber) || '';
      userPayload.ifscCode = clean(value.ifscCode) || '';
    }

    const user = await User.create(userPayload);

    /**
     * REQUIREMENT: Linking Emergency Guest Tasks to Real Account
     * Find any tasks that were posted by a guest using this mobile number
     * and transfer ownership to the new registered user.
     */
    if (user.role === 'client') {
      try {
        await Task.updateMany(
          { 
            isGuestTask: true, 
            'guestInfo.mobile': mobile 
          },
          { 
            $set: { 
              client: user._id, 
              isGuestTask: false,
              company: user.company || ''
            },
            $unset: { guestInfo: 1 } 
          }
        );
      } catch (linkErr) {
        console.error('Task linking failed during signup:', linkErr.message);
      }
    }

    const safeUser = await User.findById(user._id).select('-password');

    return res.status(201).json({ 
      message: 'User created successfully', 
      user: safeUser 
    });

  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ 
        message: 'Error creating user profile', 
        error: err.message 
    });
  }
});

////////////////////////////////////////////////////////////
/// LOGIN
////////////////////////////////////////////////////////////

router.post('/login', async (req, res) => {
  try {
    const { error, value } = loginSchema.validate(req.body, { stripUnknown: true });

    if (error) {
      return res.status(400).json({ 
          message: 'Validation error', 
          details: error.details.map((d) => d.message) 
      });
    }

    const email = clean(value.email).toLowerCase();
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'Account not found' });

    if (!user.isApproved) {
      return res.status(403).json({ message: 'Account pending admin approval' });
    }

    const match = await bcrypt.compare(value.password, user.password);
    if (!match) return res.status(401).json({ message: 'Invalid password' });

    const token = jwt.sign(
        { id: user._id, role: user.role }, 
        process.env.JWT_SECRET, 
        { expiresIn: '7d' }
    );

    const safeUser = await User.findById(user._id).select('-password');

    return res.json({ token, user: safeUser });
  } catch (err) {
    return res.status(500).json({ message: 'Login processing error', error: err.message });
  }
});

////////////////////////////////////////////////////////////
/// PASSWORD RESET
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

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetPasswordOTP = otp;
    user.resetPasswordExpires = Date.now() + 600000; // 10 mins
    await user.save();

    await transporter.sendMail({
      from: '"SKILEN Support" <krrinnovations@gmail.com>',
      to: email,
      subject: 'Password Reset OTP',
      html: `<p>Hello ${user.name},</p><p>Use the code <b>${otp}</b> to reset your password.</p>`,
    });

    return res.json({ success: true, message: "OTP sent successfully." });
  } catch (err) {
    return res.status(500).json({ message: "Failed to send reset code" });
  }
});

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
      return res.status(400).json({ message: "Invalid or expired OTP." });
    }

    user.password = await bcrypt.hash(value.newPassword, 10);
    user.resetPasswordOTP = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.json({ success: true, message: "Password updated." });
  } catch (err) {
    return res.status(500).json({ message: "Failed to reset password" });
  }
});

////////////////////////////////////////////////////////////
/// FCM TOKEN
////////////////////////////////////////////////////////////

router.post('/register-fcm', verifyJWT, async (req, res) => {
  try {
    const { error, value } = registerFcmSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ message: 'Invalid token data' });

    await User.findByIdAndUpdate(req.user.id, { fcmToken: clean(value.fcmToken) });
    return res.json({ message: 'Notification token updated' });
  } catch (err) {
    return res.status(500).json({ message: 'FCM sync failed' });
  }
});

module.exports = router;