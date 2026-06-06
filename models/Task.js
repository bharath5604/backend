// backend/models/Task.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Reusable string array sanitizer
 */
function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

/**
 * Submission Sub Schema
 */
const submissionSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Submission student is required'],
    },
    fileUrl: {
      type: String,
      required: [true, 'Submission file URL is required'],
      trim: true,
      maxlength: [2000, 'Submission file URL cannot exceed 2000 characters'],
    },
    notes: {
      type: String,
      default: '',
      trim: true,
      maxlength: [2000, 'Submission notes cannot exceed 2000 characters'],
    },
    // Representing if the Student work is approved by the CLIENT
    approved: {
      type: Boolean,
      default: false,
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    clientApprovedAt: {
      type: Date,
      default: null,
    }
  },
  { _id: false }
);

/**
 * Main Task Schema
 */
const taskSchema = new Schema(
  {
    /**
     * Basic Info
     */
    title: {
      type: String,
      required: [true, 'Task title is required'],
      trim: true,
      maxlength: [150, 'Task title cannot exceed 150 characters'],
    },

    description: {
      type: String,
      required: [true, 'Task description is required'],
      trim: true,
      maxlength: [5000, 'Task description cannot exceed 5000 characters'],
    },

    /**
     * Guest vs Registered Client Logic
     */
    isGuestTask: {
      type: Boolean,
      default: false,
    },

    // For registered clients
    client: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: false, // Optional to support guest tasks
      index: true,
    },

    // For unlogged-in clients (Emergency Tasks)
    guestInfo: {
      name: { type: String, trim: true },
      mobile: { type: String, trim: true },
      email: { type: String, trim: true },
    },

    clientAgreedToTerms: {
      type: Boolean,
      default: false,
    },

    /**
     * Admin & Assignment
     */
    assignedByAdmin: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    requiredSkills: {
      type: [String],
      default: [],
      set: normalizeStringArray,
    },

    /**
     * Budget (Now Optional)
     */
    budget: {
      type: Number,
      required: false, // Requirement: Estimated amount is optional
      min: [0, 'Budget cannot be negative'],
    },

    deadline: {
      type: Date,
      required: [true, 'Deadline is required'],
    },

    /**
     * Filters
     */
    location: {
      type: String,
      trim: true,
      default: '',
    },

    domain: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    company: {
      type: String,
      trim: true,
      default: '',
    },

    /**
     * MODIFIED TASK STATUSES (Removed Payment States)
     */
    status: {
      type: String,
      enum: [
        'open', 
        'request_sent', 
        'assigned', 
        'under_review', 
        'completed', 
        'declined'
      ],
      default: 'open',
      index: true,
    },

    /**
     * Permissions Logic (Admin controlled)
     */
    clientCanViewSubmission: {
      type: Boolean,
      default: false,
    },

    /**
     * Student Info
     */
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    assignmentRequestStatus: {
      type: String,
      enum: [null, 'request_sent', 'request_rejected'],
      default: null,
    },

    requestedStudent: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    studentAgreedToTerms: {
      type: Boolean,
      default: false,
    },

    /**
     * Submission & Results
     */
    submission: {
      type: submissionSchema,
      default: null,
    },

    rating: { type: Number, default: 0 },
    feedback: { type: String, default: '', trim: true },
    score: { type: Number, default: 0 },

    attemptCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/**
 * Pre-validation cleanup
 */
taskSchema.pre('validate', function () {
  this.title = String(this.title || '').trim();
  this.description = String(this.description || '').trim();
  this.location = String(this.location || '').trim();
  this.domain = String(this.domain || '').trim();
  this.company = String(this.company || '').trim();

  if (this.guestInfo) {
    if (this.guestInfo.name) this.guestInfo.name = String(this.guestInfo.name).trim();
    if (this.guestInfo.mobile) this.guestInfo.mobile = String(this.guestInfo.mobile).trim();
  }
});

/**
 * Business-rule validation
 */
taskSchema.pre('validate', function () {
  
  // Requirement: Registered tasks need client ID, Guest tasks need guestInfo
  if (!this.isGuestTask && !this.client) {
    throw new Error('Registered tasks require a client reference');
  }

  if (this.isGuestTask && (!this.guestInfo || !this.guestInfo.name || !this.guestInfo.mobile)) {
    throw new Error('Guest tasks require name and mobile number');
  }

  // Ensure 'student' is null for unassigned tasks
  if (['open', 'request_sent'].includes(this.status)) {
    this.student = null;
  }

  // Validation for active tasks
  if (['assigned', 'under_review', 'completed'].includes(this.status)) {
    if (!this.student) {
      throw new Error('Assigned student is required for this status');
    }
  }
});

module.exports = mongoose.model('Task', taskSchema);