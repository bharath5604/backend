// backend/models/Task.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Reusable string array sanitizer (RESTORED)
 */
function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

/**
 * Submission Sub Schema
 * Tracks the work uploaded by the student and the client's approval status.
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
    
    // Specifically tracks the time the Client clicked "Approve" for your workflow
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
      minlength: [3, 'Task title must be at least 3 characters'],
      maxlength: [150, 'Task title cannot exceed 150 characters'],
    },

    description: {
      type: String,
      required: [true, 'Task description is required'],
      trim: true,
      minlength: [10, 'Task description must be at least 10 characters'],
      maxlength: [5000, 'Task description cannot exceed 5000 characters'],
    },

    /**
     * Client Info & SKILEN Agreement
     */
    client: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Client is required'],
      index: true,
    },

    // Tracks if client agreed to the SKILEN T&C during task creation
    clientAgreedToTerms: {
      type: Boolean,
      default: false,
    },

    /**
     * Admin assignment tracking
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

    /**
     * Skills Required
     */
    requiredSkills: {
      type: [String],
      default: [],
      set: normalizeStringArray,
    },

    /**
     * Budget & Deadline
     */
    budget: {
      type: Number,
      required: [true, 'Budget is required'],
      min: [0, 'Budget cannot be negative'],
      validate: {
        validator(value) {
          return Number.isFinite(value);
        },
        message: 'Budget must be a valid number',
      },
    },

    deadline: {
      type: Date,
      required: [true, 'Deadline is required'],
      validate: {
        validator(value) {
          return value instanceof Date && !Number.isNaN(value.getTime());
        },
        message: 'Deadline must be a valid date',
      },
    },

    /**
     * Filters
     */
    location: {
      type: String,
      trim: true,
      default: '',
      maxlength: [120, 'Location cannot exceed 120 characters'],
    },

    domain: {
      type: String,
      trim: true,
      default: '',
      maxlength: [120, 'Domain cannot exceed 120 characters'],
      index: true,
    },

    company: {
      type: String,
      trim: true,
      default: '',
      maxlength: [150, 'Company cannot exceed 150 characters'],
    },

    /**
     * UPDATED TASK STATUSES FOR PAYMENT WORKFLOW
     *
     * open                   - Posted by Client
     * request_sent           - Admin invited student ("Ticked" them)
     * awaiting_advance       - Student accepted, waiting for 20% payment
     * assigned               - 20% paid, student is now working
     * under_review           - Student submitted work, Client review pending
     * awaiting_final_payment - Client approved work, waiting for 80% payment
     * completed              - 100% paid, task finalized
     * declined               - Permanently cancelled
     */
    status: {
      type: String,
      enum: [
        'open', 
        'request_sent', 
        'awaiting_advance', 
        'assigned', 
        'under_review', 
        'awaiting_final_payment', 
        'completed', 
        'declined'
      ],
      default: 'open',
      index: true,
    },

    /**
     * Final Assigned Student (Locked after 20% payment)
     */
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    /**
     * Invitation Flow Metadata
     */
    assignmentRequestStatus: {
      type: String,
      enum: [null, 'request_sent', 'request_rejected'],
      default: null,
      index: true,
    },

    requestedStudent: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    // Tracks if student agreed to the SKILEN Eligibility T&C during acceptance
    studentAgreedToTerms: {
      type: Boolean,
      default: false,
    },

    requestSentAt: {
      type: Date,
      default: null,
    },

    requestRespondedAt: {
      type: Date,
      default: null,
    },

    requestRejectionReason: {
      type: String,
      default: '',
      trim: true,
      maxlength: [1000, 'Rejection reason cannot exceed 1000 characters'],
    },

    /**
     * Execution Metadata
     */
    attemptCount: {
      type: Number,
      default: 0,
      min: [0, 'Attempt count cannot be negative'],
    },

    maxAttempts: {
      type: Number,
      default: 3,
      min: [1, 'Max attempts must be at least 1'],
      max: [10, 'Max attempts cannot exceed 10'],
    },

    /**
     * Assets
     */
    attachments: {
      type: [String],
      default: [],
      set(value) {
        return normalizeStringArray(value);
      },
    },

    attachmentNames: {
      type: [String],
      default: [],
      set(value) {
        return normalizeStringArray(value);
      },
    },

    /**
     * Results
     */
    submission: {
      type: submissionSchema,
      default: null,
    },

    /**
     * Ratings & Feedback
     */
    rating: {
      type: Number,
      default: 0,
      min: [0, 'Rating cannot be below 0'],
      max: [5, 'Rating cannot be above 5'],
    },

    feedback: {
      type: String,
      default: '',
      trim: true,
      maxlength: [2000, 'Feedback cannot exceed 2000 characters'],
    },

    score: {
      type: Number,
      default: 0,
      min: [0, 'Score cannot be below 0'],
      max: [5, 'Score cannot be above 5'],
    },

    /**
     * Policy
     */
    chatMode: {
      type: String,
      enum: ['admin_only'],
      default: 'admin_only',
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/**
 * Indexes for faster querying
 */
taskSchema.index({ requiredSkills: 1 });
taskSchema.index({ location: 1 });
taskSchema.index({ client: 1, createdAt: -1 });
taskSchema.index({ student: 1, createdAt: -1 });
taskSchema.index({ status: 1, createdAt: -1 });
taskSchema.index({ domain: 1, status: 1, createdAt: -1 });
taskSchema.index({ assignmentRequestStatus: 1, requestedStudent: 1 });

/**
 * Pre-validation cleanup (Trimming logic)
 */
taskSchema.pre('validate', function () {
  this.title = String(this.title || '').trim();
  this.description = String(this.description || '').trim();
  this.location = String(this.location || '').trim();
  this.domain = String(this.domain || '').trim();
  this.company = String(this.company || '').trim();
  this.feedback = String(this.feedback || '').trim();

  if (this.submission?.notes != null) {
    this.submission.notes = String(this.submission.notes || '').trim();
  }

  if (this.requestRejectionReason != null) {
    this.requestRejectionReason = String(this.requestRejectionReason || '').trim();
  }
});

/**
 * Business-rule validation
 */
taskSchema.pre('validate', function () {
  
  // Rule: If task is not yet fully assigned, 'student' field must be null
  if (['open', 'request_sent', 'awaiting_advance'].includes(this.status)) {
    this.student = null;
  }

  // Rule: If status is 'assigned' or beyond, validation for student data
  if (['assigned', 'under_review', 'awaiting_final_payment', 'completed'].includes(this.status)) {
    if (!this.student) {
      throw new Error('Assigned student is required for this status');
    }
    if (!this.assignedByAdmin) {
      throw new Error('assignedByAdmin record is required for active tasks');
    }
    if (!this.studentAgreedToTerms) {
      throw new Error('Assignment requires Student Terms & Conditions agreement');
    }
  }

  // Rule: Submission student must match assigned student
  if (this.submission && this.student) {
    if (this.submission.student.toString() !== this.student.toString()) {
      throw new Error('Submission student must match assigned student');
    }
  }

  // Rule: Attempt count safety
  if (this.attemptCount > this.maxAttempts) {
    throw new Error('Attempt count cannot exceed max attempts');
  }

  // Workflow Alignment: Once 20% is paid and task moves to 'assigned', clear the invite fields
  if (this.status === 'assigned') {
    this.assignmentRequestStatus = null;
    this.requestedStudent = null;
  }
});

module.exports = mongoose.model('Task', taskSchema);