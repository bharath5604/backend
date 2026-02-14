// models/User.js
const mongoose = require('mongoose');

// Per-domain aggregate scores (for domain-wise averages)
const feedbackScoreSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true },
    totalScore: { type: Number, default: 0 }, // sum of all 1–5 ratings
    count: { type: Number, default: 0 },      // number of ratings
  },
  { _id: false }
);

// Individual feedback entries per project/task
const feedbackEntrySchema = new mongoose.Schema(
  {
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
    },
    taskTitle: { type: String, required: true },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    clientName: { type: String, required: true },

    // 1–5 rating given by client
    rating: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },

    // Optional free‑text feedback
    comment: { type: String },

    domain: { type: String }, // domain of the task, useful for filtering
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },

    role: {
      type: String,
      enum: ['student', 'client', 'admin'],
      required: true,
    },

    wallet: { type: Number, default: 0 },

    // employer metadata (client)
    company: String,
    // For clients: city / location (e.g. "Vijayawada")
    location: String,
    // For clients: main domain/category of tasks they usually post
    domain: String,

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

    // Sum of all 1–5 ratings received from clients
    totalScore: { type: Number, default: 0 },

    // Number of ratings received
    totalScoreCount: { type: Number, default: 0 },

    // Domain-wise aggregated scores: each entry stores sum and count,
    // frontend computes average = totalScore / count (out of 5).
    feedbackScores: {
      type: [feedbackScoreSchema],
      default: [],
    },

    // Detailed feedback entries per project/task
    feedbackEntries: {
      type: [feedbackEntrySchema],
      default: [],
    },

    // client profile fields
    description: String,

    // FCM token for push notifications
    fcmToken: String,

    // Last login timestamp (for analytics: active users, retention)
    lastLoginAt: { type: Date },

    // Approval / ban flag:
    // - student: auto true (can use app immediately)
    // - client: requires admin approval (starts false)
    // - admin: true (managed manually)
    isApproved: {
      type: Boolean,
      default: function () {
        if (this.role === 'student') return true;
        if (this.role === 'client') return false;
        if (this.role === 'admin') return true;
        return false;
      },
    },
  },
  { timestamps: true }
);

// Optional virtual for average rating (0–5), handy in some APIs
userSchema.virtual('averageScore').get(function () {
  if (!this.totalScoreCount || this.totalScoreCount === 0) return 0;
  return this.totalScore / this.totalScoreCount;
});

module.exports = mongoose.model('User', userSchema);
