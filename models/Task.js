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
 * Tracks the work uploaded by the student.
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
    // Approved by Client (This triggers the final status)
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
     * Client Logic: Registered vs Guest (Emergency Task)
     */
    isGuestTask: {
      type: Boolean,
      default: false,
    },

    // Optional for Guest Tasks; Required for Registered Tasks
    client: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
    },

    // Stores contact details for Guest/Emergency clients
    guestInfo: {
      name: { type: String, trim: true },
      mobile: { type: String, trim: true },
      email: { type: String, trim: true },
    },

    /**
     * Workflow Statuses
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
     * REQUIREMENT: Gated Access Control
     */
    
    // Defaulted to true: Client can see that work was submitted immediately
    clientCanViewSubmission: {
      type: Boolean,
      default: true,
    },

    // Defaulted to false: Client cannot download/save the file until Admin allows it
    clientCanDownload: { 
      type: Boolean, 
      default: false 
    },

    /**
     * Requirement: Manual Payment Chain Tracking
     * (Client -> Admin -> Student)
     */
    adminReceivedPayment: {
      type: Boolean,
      default: false,
    },

    adminPaidStudent: {
      type: Boolean,
      default: false,
    },

    // If true, Client UI shows Razorpay. If false, shows Static QR.
    budgetFinalized: {
      type: Boolean,
      default: false
    },

    /**
     * Project Parameters
     */
    budget: {
      type: Number,
      required: false, 
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
     * Matching & Accountability
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

    // ============================================================
    // MODIFICATION: PERSISTENT INSTRUCTIONS FOR STUDENT
    // Stores the reason/notes provided when a client requests modification.
    // ============================================================
    modificationNotes: {
      type: String,
      default: '',
      trim: true
    },

    attemptCount: { type: Number, default: 0 },


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

  if (this.isGuestTask && this.guestInfo) {
    if (this.guestInfo.name) this.guestInfo.name = String(this.guestInfo.name).trim();
    if (this.guestInfo.mobile) this.guestInfo.mobile = String(this.guestInfo.mobile).trim();
  }
});

/**
 * Business rule enforcement
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
      throw new Error('Assigned student is required for active or completed projects');
    }
  }
});

module.exports = mongoose.model('Task', taskSchema);