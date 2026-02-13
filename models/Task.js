// Task.js
const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema(
  {
    title: String,
    description: String,

    client: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // skills required for this task (used to match with student.skills)
    requiredSkills: {
      type: [String],
      default: [],
    },

    budget: Number,
    deadline: Date,

    // filters
    location: String,
    domain: String,
    company: String,

    status: {
      type: String,
      enum: ['open', 'assigned', 'under_review', 'completed'],
      default: 'open',
    },

    // assigned student for this task (used by chat and payments)
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // attachments uploaded by client for this task
    attachments: {
      type: [String], // e.g. Firebase Storage download URLs
      default: [],
    },
    attachmentNames: {
      type: [String], // original filenames for display
      default: [],
    },

    // submission from student
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
    },

    rating: { type: Number, default: 0 },

    // client feedback and score
    feedback: {
      type: String,
      default: '',
    },
    score: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Task', taskSchema);
