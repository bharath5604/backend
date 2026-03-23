// models/Message.js
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
      index: true,
    },

    // Who sent the message
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Who receives this specific message
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Optional: for pre‑assignment client↔student chat we may want to know
    // which student this thread is about (even if not yet assigned on Task)
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    // Text is optional because a message can be "file only"
    text: {
      type: String,
      trim: true,
    },

    // Optional Firebase Storage download URL for an attachment
    fileUrl: {
      type: String,
      trim: true,
    },

    // Optional display name for the attachment
    fileName: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// For querying messages per task (+ optional student) efficiently
messageSchema.index({ task: 1, student: 1, createdAt: 1 });

// Auto-delete messages 24 hours after creation
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('Message', messageSchema);