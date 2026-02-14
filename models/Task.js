// models/Task.js
const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema(
  {
    title: String,
    description: String,

    // Client who created the task
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Skills required for this task (used to match with student.skills)
    requiredSkills: {
      type: [String],
      default: [],
    },

    budget: Number,
    deadline: Date,

    // Filters
    location: String,
    domain: String,
    company: String,

    status: {
      type: String,
      enum: ['open', 'assigned', 'under_review', 'completed'],
      default: 'open',
    },

    // Assigned student for this task (used by chat and manual payments)
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // Attachments uploaded by client for this task
    attachments: {
      type: [String], // e.g. Firebase Storage download URLs
      default: [],
    },
    attachmentNames: {
      type: [String], // original filenames for display
      default: [],
    },

    // Submission from student
    submission: {
      student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      fileUrl: String,
      notes: {
        type: String,
        default: '',
      },
      approved: { type: Boolean, default: false },
      submittedAt: {
        type: Date,
      },
      declined: {
        type: Boolean,
        default: false,
      },
      declineReason: {
        type: String,
        default: '',
      },
      // Optional: when client reviewed (approved/declined)
      reviewedAt: {
        type: Date,
      },
    },

    // Single rating given by client to this task (1–5)
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: 0,
    },

    // Client feedback text for this task
    feedback: {
      type: String,
      default: '',
    },

    // Optional numeric score if you want to keep a different weighting
    // (e.g. rating * 2), but student averages should use 1–5 rating.
    score: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Task', taskSchema);
