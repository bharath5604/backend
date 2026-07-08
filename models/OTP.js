const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  otp: { type: String, required: true },
  // Store the full signup payload (hashed) until they verify
  signupData: { type: Object, required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 } // Auto-delete after 10 mins
});

module.exports = mongoose.model('OTP', otpSchema);