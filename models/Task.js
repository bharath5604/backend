const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Submission Sub Schema
 */
const submissionSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    fileUrl: {
      type: String,
      required: true,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    approved: {
      type: Boolean,
      default: false,
    },

    submittedAt: {
      type: Date,
      default: Date.now,
    },
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
      required: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
      trim: true,
    },

    /**
     * Client Info
     */
    client: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    /**
     * Skills Required
     */
    requiredSkills: {
      type: [String],
      default: [],
    },

    /**
     * Budget & Deadline
     */
    budget: {
      type: Number,
      required: true,
      min: 0,
    },

    deadline: {
      type: Date,
      required: true,
    },

    /**
     * Filters
     */
    location: {
      type: String,
      trim: true,
      default: "",
    },

    domain: {
      type: String,
      trim: true,
      default: "",
    },

    company: {
      type: String,
      trim: true,
      default: "",
    },

    /**
     * Task Status
     *
     * open          - posted, no student assigned yet
     * assigned      - student accepted / bid accepted
     * under_review  - student submitted; client reviewing
     * completed     - approved & paid
     * declined      - hard-declined after max attempts
     */
    status: {
      type: String,
      enum: ["open", "assigned", "under_review", "completed", "declined"],
      default: "open",
      index: true,
    },

    /**
     * Assigned Student
     */
    student: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    /**
     * Submission attempts
     * - attemptCount: how many times client has declined this student's submission
     * - maxAttempts: maximum allowed declines / resubmits (business rule = 3)
     */
    attemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    maxAttempts: {
      type: Number,
      default: 3,
      min: 1,
    },

    /**
     * Client Attachments
     */
    attachments: {
      type: [String],
      default: [],
    },

    attachmentNames: {
      type: [String],
      default: [],
    },

    /**
     * Student Submission
     */
    submission: {
      type: submissionSchema,
      default: null,
    },

    /**
     * Rating & Feedback
     */
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },

    feedback: {
      type: String,
      default: "",
      trim: true,
    },

    score: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Index for faster searching
 */
taskSchema.index({ requiredSkills: 1 });
taskSchema.index({ domain: 1 });
taskSchema.index({ location: 1 });

/**
 * Export Model
 */
module.exports = mongoose.model("Task", taskSchema);
