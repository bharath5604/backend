// backend/routes/auth.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Task = require('../models/Task'); 
const OTP = require('../models/OTP'); // NEW: Temporary storage for OTP verification
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const nodemailer = require('nodemailer');
const verifyJWT = require('../middleware/authMiddleware');
const { sendNotification } = require('../utils/fcm');

// =========================================================
// EMAIL CONFIGURATION
// =========================================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD, 
  },
});

////////////////////////////////////////////////////////////
/// Helpers
////////////////////////////////////////////////////////////

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Real-time Broadcast Helper
 */
const emitAuthUpdate = (req, event, data) => {
  const io = req.app.get('socketio');
  if (io) {
    io.emit(event, data);
    io.emit('admin_stats_update', { timestamp: new Date() });
  }
};

////////////////////////////////////////////////////////////
/// JOI SCHEMAS
////////////////////////////////////////////////////////////

const signupSchema = Joi.object({
  name: Joi.string().min(2).max(100).regex(/^[a-zA-Z\s]+$/).required().messages({
     'string.empty': 'Name is required',
      'string.pattern.base': 'Name must only contain alphabets and spaces',
      'string.min': 'Name must be at least 2 characters'
  }),
  email: Joi.string().email().max(200).required().messages({
    'string.email': 'Invalid email format'
  }),
  mobile: Joi.string().min(10).max(15).required().messages({
    'string.min': 'Mobile must be at least 10 digits'
  }),
  password: Joi.string()
    .min(8)
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>])/)
    .required()
    .messages({
      'string.min': 'Password must be at least 8 characters',
      'string.pattern.base': 'Password must include Uppercase, Lowercase, Number, and Symbol'
    }),
  role: Joi.string().valid('student', 'client', 'admin').required(),
  location: Joi.string().max(200).required().messages({
    'string.empty': 'Location is required for account vetting'
  }),
  idCardUrl: Joi.string().uri().allow('', null),
  company: Joi.string().max(200).allow('', null),
  domain: Joi.string().max(200).allow('', null),
  skills: Joi.array().items(Joi.string().max(100)).default([]),
  bankAccountHolderName: Joi.string().max(200).allow('', null),
  bankAccountNumber: Joi.string().regex(/^\d{9,18}$/).allow('', null),
  ifscCode: Joi.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).allow('', null),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

////////////////////////////////////////////////////////////
/// SIGNUP PHASE 1: SEND OTP
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
        details: error.details.map((d) => ({ field: d.path[0], message: d.message })),
      });
    }

    const email = clean(value.email).toLowerCase();

    // 1. Check if user already exists
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: 'Email address already registered' });
    }

    // 2. Prepare Data (Hash Password Now)
    const hashed = await bcrypt.hash(value.password, 10);
    const userPayload = { ...value, email, password: hashed };

    // 3. Generate 6-Digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // 4. Save to temporary OTP store (Delete previous attempts first)
    await OTP.findOneAndDelete({ email });
    await OTP.create({
      email,
      otp: otpCode,
      signupData: userPayload
    });

    // 5. Send verification email
    await transporter.sendMail({
      from: '"SKILERN Support" <skilernapp@gmail.com>',
      to: email,
      subject: 'Verify your Skilern Account',
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #6A11CB;">Verification Code</h2>
          <p>Hello ${value.name},</p>
          <p>Thank you for joining Skilern. Please use the following code to verify your account:</p>
          <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #2575FC; margin: 20px 0;">
            ${otpCode}
          </div>
          <p style="color: #888; font-size: 12px;">This code is valid for 10 minutes.</p>
        </div>
      `,
    });

    return res.status(200).json({ 
        success: true, 
        message: 'Verification code sent to your email.' 
    });

  } catch (err) {
    console.error('Signup Error:', err);
    return res.status(500).json({ message: 'Failed to send verification email' });
  }
});

////////////////////////////////////////////////////////////
/// SIGNUP PHASE 2: VERIFY OTP & CREATE USER
////////////////////////////////////////////////////////////

router.post('/verify-signup', async (req, res) => {
    try {
        const { email, otp } = req.body;

        // 1. Find the OTP record
        const record = await OTP.findOne({ email: email.toLowerCase(), otp });
        if (!record) {
            return res.status(400).json({ message: "Invalid or expired OTP" });
        }

        // 2. Create real user from stored signupData
        const userData = record.signupData;
        
        // Manual cleanup for client default state
        if (userData.role === 'client') {
            userData.isApproved = false;
        } else {
            userData.isApproved = true;
        }

        const user = await User.create(userData);

        // 3. Cleanup: Remove OTP record
        await OTP.deleteOne({ _id: record._id });

        // 4. Trigger Real-time signals
        emitAuthUpdate(req, 'user_registered', { userId: user._id, role: user.role });

        // 5. Link Emergency Guest Tasks
        if (user.role === 'client') {
            await Task.updateMany(
                { isGuestTask: true, 'guestInfo.mobile': user.mobile },
                { 
                  $set: { client: user._id, isGuestTask: false, company: user.company || '' }, 
                  $unset: { guestInfo: 1 } 
                }
            );
        }

        // 6. Notify Admin via VPS Messenger (Pass req)
        const adminUser = await User.findOne({ role: 'admin' });
        if (adminUser) {
            await sendNotification(adminUser._id.toString(), {
                title: "New Registration",
                body: `${user.name} joined as a ${user.role}.`,
                data: { type: "user_status_update" }
            }, req);
        }

        const safeUser = await User.findById(user._id).select('-password');
        return res.status(201).json({ 
            success: true, 
            message: 'Account verified successfully', 
            user: safeUser 
        });

    } catch (err) {
        console.error('Verification Error:', err);
        return res.status(500).json({ message: 'Verification failed' });
    }
});

////////////////////////////////////////////////////////////
/// LOGIN
////////////////////////////////////////////////////////////

router.post('/login', async (req, res) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ message: "Email and Password required" });

    const user = await User.findOne({ email: value.email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'Account not found' });

    if (!user.isApproved) {
      return res.status(403).json({ message: 'Account pending admin approval.' });
    }

    const match = await bcrypt.compare(value.password, user.password);
    if (!match) return res.status(401).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    user.lastLoginAt = new Date();
    await user.save();

    const safeUser = await User.findById(user._id).select('-password');
    return res.json({ token, user: safeUser });
  } catch (err) {
    return res.status(500).json({ message: 'Login error' });
  }
});

////////////////////////////////////////////////////////////
/// PASSWORD RESET
////////////////////////////////////////////////////////////

router.post('/forgot-password', async (req, res) => {
  try {
    const email = clean(req.body.email).toLowerCase();
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "Email not found" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetPasswordOTP = otp;
    user.resetPasswordExpires = Date.now() + 600000; 
    await user.save();

    await transporter.sendMail({
      from: '"SKILERN Support" <skilernapp@gmail.com>',
      to: email,
      subject: 'Password Reset OTP',
      html: `<p>Hello ${user.name},</p><p>Use code <b>${otp}</b> to reset your password.</p>`,
    });

    return res.json({ success: true, message: "OTP sent successfully" });
  } catch (err) { return res.status(500).json({ message: "Failed to send reset email" }); }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    const user = await User.findOne({ 
      email: email.toLowerCase(), 
      resetPasswordOTP: otp, 
      resetPasswordExpires: { $gt: Date.now() } 
    });

    if (!user) return res.status(400).json({ message: "Invalid or expired OTP" });

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordOTP = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.json({ success: true, message: "Password updated successfully" });
  } catch (err) { return res.status(500).json({ message: "Reset failed" }); }
});

router.post('/register-fcm', verifyJWT, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, { fcmToken: clean(req.body.fcmToken) });
    return res.json({ message: 'Token updated' });
  } catch (err) { return res.status(500).json({ message: 'FCM sync failed' }); }
});

module.exports = router;