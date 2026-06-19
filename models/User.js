// backend/models/User.js
const mongoose = require('mongoose');

////////////////////////////////////////////////////
/// Feedback Score Schema (Used for Domain Sorting)
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
/// Feedback Entry Schema (Historical records)
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
      trim: true
    },

    email: {
      type: String,
      unique: true,
      required: true,
      trim: true,
      lowercase: true
    },

    mobile: {
      type: String,
      required: true,
      trim: true
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

    // Used by both Students and Clients for vetting and matching
    location: {
      type: String,
      trim: true,
      default: ''
    },

    ////////////////////////////////////////////////////
    /// AUTHENTICATION / PASSWORD RESET
    ////////////////////////////////////////////////////

    resetPasswordOTP: {
      type: String,
      default: null,
    },

    resetPasswordExpires: {
      type: Date,
      default: null,
    },

    ////////////////////////////////////////////////////
    /// CLIENT FIELDS
    ////////////////////////////////////////////////////

    company: {
      type: String,
      trim: true,
      default: ''
    },
    domain: {
      type: String,
      trim: true,
      default: ''
    },
    description: {
      type: String,
      trim: true,
      default: ''
    },

    ////////////////////////////////////////////////////
    /// STUDENT FIELDS
    ////////////////////////////////////////////////////

    // bio: {
    //   type: String,
    //   trim: true,
    //   default: ''
    // },

    skills: {
      type: [String],
      default: [],
    },

    portfolioUrl: {
      type: String,
      trim: true,
      default: ''
    },

    // ============================================================
    // MODIFICATION: STUDENT IDENTITY PROOF (SOLVES IMAGE ISSUE)
    // Pointer to Firebase Storage URL
    // ============================================================
    idCardUrl: {
      type: String,
      trim: true,
      default: ''
    },

    ////////////////////////////////////////////////////
    /// BANK DETAILS (Kept for Admin view in "Complete Details")
    ////////////////////////////////////////////////////

    bankAccountHolderName: {
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
    /// REPUTATION & EXPERIENCE (Used for Admin Sorting)
    ////////////////////////////////////////////////////

    tasksCompleted: {
      type: Number,
      default: 0,
    },

    totalScore: {
      type: Number,
      default: 0,
    },

    totalScoreCount: {
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
    /// NOTIFICATIONS & LOGS
    ////////////////////////////////////////////////////

    fcmToken: String,

    lastLoginAt: {
      type: Date,
    },

    ////////////////////////////////////////////////////
    /// APPROVAL LOGIC
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
  { 
    timestamps: true,
    toJSON: { virtuals: true , getters: true },
    toObject: { virtuals: true ,getters: true  }
  }
);

////////////////////////////////////////////////////
/// VIRTUALS
////////////////////////////////////////////////////

userSchema.virtual('averageScore').get(function () {
  if (!this.totalScoreCount || this.totalScoreCount === 0) return 0;
  return (this.totalScore / this.totalScoreCount).toFixed(1);
});

module.exports = mongoose.model('User', userSchema);