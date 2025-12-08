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
    // store deadline as string or Date; if you use Date, keep consistent with client
    deadline: Date,

    // filters
    // city / place where task is based; used in student feed location filter
    location: String,
    // domain/category of the task (e.g. "Web Development", "Machine Learning")
    domain: String,
    company: String,

    status: {
      type: String,
      enum: ['open', 'assigned', 'completed'],
      default: 'open',
    },

    submission: {
      fileUrl: String,
      student: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
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
