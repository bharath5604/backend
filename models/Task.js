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
 * Tracks work uploaded by the student.
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
    // Approved by Client
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
     * Client Types: Guest (Landing page) vs Registered
     */
    isGuestTask: {
      type: Boolean,
      default: false,
    },

    // For registered clients
    client: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
    },

    // For unlogged-in clients (Emergency Task Flow)
    guestInfo: {
      name: { type: String, trim: true },
      mobile: { type: String, trim: true },
      email: { type: String, trim: true },
    },

    /**
     * Admin Control & Workflow
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

    // Admin grants permission for client to view student work
    clientCanViewSubmission: {
      type: Boolean,
      default: false,
    },

    /**
     * NEW: Direct Payment Chain Tracking
     * Client -> Admin -> Student
     */
    adminReceivedPayment: {
      type: Boolean,
      default: false,
    },

    adminPaidStudent: {
      type: Boolean,
      default: false,
    },

    /**
     * Budget & Details
     */
    budget: {
      type: Number,
      required: false, // Optional as per requirement
      min: [0, 'Budget cannot be negative'],
    },

    deadline: {
      type: Date,
      required: [true, 'Deadline is required'],
    },

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

    requiredSkills: {
      type: [String],
      default: [],
      set: normalizeStringArray,
    },

    /**
     * Matching & Assignment
     */
    assignedByAdmin: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    requestedStudent: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    assignmentRequestStatus: {
      type: String,
      enum: [null, 'request_sent', 'request_rejected'],
      default: null,
    },

    studentAgreedToTerms: {
      type: Boolean,
      default: false,
    },

    /**
     * Deliverables & Feedback
     */
    submission: {
      type: submissionSchema,
      default: null,
    },

    attemptCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },

    rating: { type: Number, default: 0 },
    feedback: { type: String, default: '', trim: true },
    score: { type: Number, default: 0 },
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

  if (this.guestInfo) {
    if (this.guestInfo.name) this.guestInfo.name = String(this.guestInfo.name).trim();
    if (this.guestInfo.mobile) this.guestInfo.mobile = String(this.guestInfo.mobile).trim();
  }
});

/**
 * Assignment rule validation
 */
taskSchema.pre('validate', function () {
  if (!this.isGuestTask && !this.client) {
    throw new Error('Registered tasks require a client reference');
  }

  if (this.isGuestTask && (!this.guestInfo || !this.guestInfo.name || !this.guestInfo.mobile)) {
    throw new Error('Emergency tasks require name and mobile number');
  }

  if (['assigned', 'under_review', 'completed'].includes(this.status)) {
    if (!this.student) {
      throw new Error('Assigned student is required for active/completed tasks');
    }
  }
});

module.exports = mongoose.model('Task', taskSchema);