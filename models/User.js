// models/User.js
const mongoose = require('mongoose');

const feedbackScoreSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true },
    totalScore: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },

    role: { type: String, enum: ['student', 'client', 'admin'], required: true },

    wallet: { type: Number, default: 0 },

    // employer metadata (client)
    company: String,
    // For clients: city / location (e.g. "Vijayawada")
    location: String,
    // For clients: main domain/category of tasks they usually post
    domain: String,

    // shared profile images
    avatarUrl: String,  // profile photo (student & client)
    bannerUrl: String,  // banner image (mainly for clients)

    // student profile fields
    bio: String,
    // For students: list of skill/domain tags used to filter tasks in feed
    skills: {
      type: [String],
      default: [],
    },
    portfolioUrl: String,

    // student stats for ratings/feedback
    tasksCompleted: { type: Number, default: 0 },
    totalScore: { type: Number, default: 0 },
    totalScoreCount: { type: Number, default: 0 },
    feedbackScores: {
      type: [feedbackScoreSchema],
      default: [],
    },

    // client profile fields
    description: String,

    // FCM token for push notifications
    fcmToken: String,

    isApproved: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
