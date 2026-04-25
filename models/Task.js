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
 * Modified to explicitly support Client Approval as per your workflow.
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
    
    // NEW: Specifically tracks Client's interaction for your workflow
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
     * Basic Info (RESTORED)
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
     * Client Info (RESTORED)
     */
    client: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Client is required'],
      index: true,
    },

    // NEW: Track that client agreed to T&C during creation
    clientAgreedToTerms: {
      type: Boolean,
      default: false,
    },

    /**
     * Admin assignment info (RESTORED)
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
     * Skills Required (RESTORED)
     */
    requiredSkills: {
      type: [String],
      default: [],
      set: normalizeStringArray,
    },

    /**
     * Budget & Deadline (RESTORED)
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
     * Filters (RESTORED)
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
     * Task Status (RESTORED)
     * open         - posted, no student assigned yet
     * assigned     - student accepted the admin's request
     * under_review - student submitted; awaiting Client approval
     * completed    - Client approved
     * declined     - hard-declined after max attempts
     */
    status: {
      type: String,
      enum: ['open', 'assigned', 'under_review', 'completed', 'declined'],
      default: 'open',
      index: true,
    },

    /**
     * Assigned Student (FINAL Assignee after acceptance)
     */
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    /**
     * Submission attempts (RESTORED)
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
     * Client Attachments (RESTORED)
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
     * Student Submission (RESTORED)
     */
    submission: {
      type: submissionSchema,
      default: null,
    },

    /**
     * Rating & Feedback (RESTORED)
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
     * Communication policy (RESTORED)
     */
    chatMode: {
      type: String,
      enum: ['admin_only'],
      default: 'admin_only',
    },

    /**
     * Admin → student assignment request workflow (RESTORED & REFINED)
     */
    assignmentRequestStatus: {
      type: String,
      enum: [null, 'request_sent', 'terms_accepted', 'request_rejected'],
      default: null,
      index: true,
    },

    requestedStudent: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    termsAcceptedAt: {
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
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/**
 * Indexes for faster querying (RESTORED ALL)
 */
taskSchema.index({ requiredSkills: 1 });
taskSchema.index({ location: 1 });
taskSchema.index({ client: 1, createdAt: -1 });
taskSchema.index({ student: 1, createdAt: -1 });
taskSchema.index({ status: 1, createdAt: -1 });
taskSchema.index({ client: 1, status: 1, createdAt: -1 });
taskSchema.index({ domain: 1, status: 1, createdAt: -1 });
taskSchema.index({ assignedByAdmin: 1, createdAt: -1 });
taskSchema.index({ student: 1, status: 1, createdAt: -1 });
taskSchema.index({ assignmentRequestStatus: 1, requestedStudent: 1 });

/**
 * Pre-validation cleanup (RESTORED ALL ORIGINAL LOGIC)
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
 * Business-rule validation (RESTORED & REFINED FOR WORKFLOW)
 */
taskSchema.pre('validate', function () {
  
  // Logic: If task is open, it cannot have a final assigned student
  if (this.status === 'open') {
    this.student = null;
    this.assignedAt = null;
    // Note: assignedByAdmin remains for auditing who sent the request
  }

  // Logic: If assigned, student must exist
  if (
    ['assigned', 'under_review', 'completed', 'declined'].includes(this.status) &&
    !this.student
  ) {
    throw new Error('Assigned student is required when task is not open');
  }

  // Logic: If assigned, admin record must exist
  if (
    ['assigned', 'under_review', 'completed', 'declined'].includes(this.status) &&
    !this.assignedByAdmin
  ) {
    throw new Error('assignedByAdmin is required once a student is assigned');
  }

  // Logic: Submission integrity (RESTORED)
  if (this.submission && this.student) {
    const submissionStudentId = this.submission.student?.toString();
    const assignedStudentId = this.student?.toString();

    if (
      submissionStudentId &&
      assignedStudentId &&
      submissionStudentId !== assignedStudentId
    ) {
      throw new Error('Submission student must match assigned student');
    }
  }

  // Logic: Attempt constraint (RESTORED)
  if (this.attemptCount > this.maxAttempts) {
    throw new Error('Attempt count cannot exceed max attempts');
  }

  // Logic: Request Cleanup (Workflow Alignment)
  // When final assignment is done, we clear the intermediate "Tick" state
  if (this.status === 'assigned') {
    if (this.student && this.requestedStudent &&
        this.student.toString() === this.requestedStudent.toString()) {
      this.assignmentRequestStatus = null;
      this.requestedStudent = null;
    }
  }
});

module.exports = mongoose.model('Task', taskSchema);