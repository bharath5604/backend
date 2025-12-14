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
      enum: ['open', 'assigned', 'completed'],
      default: 'open',
    },

    // assigned student for this task (used by chat and payments)
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    submission: {
      fileUrl: String,
      approved: { type: Boolean, default: false },
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
