const mongoose = require('mongoose');

const bidSchema = new mongoose.Schema(
  {
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
      index: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    quote: {
      type: Number,
      required: true,
      min: 0,
    },
    timeline: {
      type: String,
      required: true,
      trim: true,
    },
    // optional message from student with details
    message: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending',
      index: true,
    },
    // NEW: when bid was accepted (for successful bids growth stats)
    acceptedAt: {
      type: Date,
    },
    // NEW: when bid was rejected
    rejectedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// OPTIONAL: keep acceptedAt / rejectedAt in sync when status changes
bidSchema.pre('save', function (next) {
  if (this.isModified('status')) {
    if (this.status === 'accepted') {
      this.acceptedAt = this.acceptedAt || new Date();
      this.rejectedAt = undefined;
    } else if (this.status === 'rejected') {
      this.rejectedAt = this.rejectedAt || new Date();
      this.acceptedAt = undefined;
    } else if (this.status === 'pending') {
      this.acceptedAt = undefined;
      this.rejectedAt = undefined;
    }
  }
  next();
});

module.exports = mongoose.model('Bid', bidSchema);
