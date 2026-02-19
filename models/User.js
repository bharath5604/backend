const mongoose = require('mongoose');

////////////////////////////////////////////////////
/// Feedback Score Schema
////////////////////////////////////////////////////

const feedbackScoreSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true },
    totalScore: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
  },
  { _id: false }
);

////////////////////////////////////////////////////
/// Feedback Entry Schema
////////////////////////////////////////////////////

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
    rating: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },
    comment: String,
    domain: String,
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

////////////////////////////////////////////////////
/// MAIN USER SCHEMA
////////////////////////////////////////////////////

const userSchema = new mongoose.Schema(
  {
    ////////////////////////////////////////////////////
    /// BASIC INFO
    ////////////////////////////////////////////////////

    name: {
      type: String,
      required: true,
    },

    email: {
      type: String,
      unique: true,
      required: true,
    },

    password: {
      type: String,
      required: true,
    },

    role: {
      type: String,
      enum: ['student', 'client', 'admin'],
      required: true,
    },

    ////////////////////////////////////////////////////
    /// WALLET
    ////////////////////////////////////////////////////

    wallet: {
      type: Number,
      default: 0,
    },

    ////////////////////////////////////////////////////
    /// CLIENT FIELDS
    ////////////////////////////////////////////////////

    company: String,
    location: String,
    domain: String,
    description: String,

    ////////////////////////////////////////////////////
    /// STUDENT FIELDS
    ////////////////////////////////////////////////////

    bio: String,
    skills: {
      type: [String],
      default: [],
    },
    portfolioUrl: String,

    ////////////////////////////////////////////////////
    /// BANK DETAILS (FLAT FIELDS)
    ////////////////////////////////////////////////////

    bankAccountHolderName: {
      type: String,
      default: '',
      trim: true,
    },
    bankName: {
      type: String,
      default: '',
      trim: true,
    },
    bankAccountNumber: {
      type: String,
      default: '',
      trim: true,
    },
    ifscCode: {
      type: String,
      default: '',
      trim: true,
    },

    ////////////////////////////////////////////////////
    /// FEEDBACK / TASK / EARNINGS STATS
    ////////////////////////////////////////////////////

    // number of tasks the student has completed
    tasksCompleted: {
      type: Number,
      default: 0,
    },

    // cumulative rating totals
    totalScore: {
      type: Number,
      default: 0,
    },
    totalScoreCount: {
      type: Number,
      default: 0,
    },

    // sum of accepted quotes not yet released (held payments)
    pendingEarnings: {
      type: Number,
      default: 0,
    },

    // sum of all released payments to this student
    totalEarningsReleased: {
      type: Number,
      default: 0,
    },

    feedbackScores: {
      type: [feedbackScoreSchema],
      default: [],
    },
    feedbackEntries: {
      type: [feedbackEntrySchema],
      default: [],
    },

    ////////////////////////////////////////////////////
    /// NOTIFICATIONS
    ////////////////////////////////////////////////////

    fcmToken: String,

    ////////////////////////////////////////////////////
    /// LOGIN TRACK
    ////////////////////////////////////////////////////

    lastLoginAt: {
      type: Date,
    },

    ////////////////////////////////////////////////////
    /// APPROVAL
    ////////////////////////////////////////////////////

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

////////////////////////////////////////////////////
/// VIRTUALS
////////////////////////////////////////////////////

userSchema.virtual('averageScore').get(function () {
  if (!this.totalScoreCount) return 0;
  return this.totalScore / this.totalScoreCount;
});

// total accepted earnings (pending + released)
userSchema.virtual('totalAcceptedEarnings').get(function () {
  return (this.pendingEarnings || 0) + (this.totalEarningsReleased || 0);
});

module.exports = mongoose.model('User', userSchema);
