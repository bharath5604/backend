// backend/models/Message.js
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
      index: true,
    },

    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /**
     * Used for grouping messages in Admin-Student specific threads.
     * If this is null, the message belongs to the Admin-Client thread.
     */
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    text: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },

    fileUrl: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },

    fileName: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },

    // ============================================================
    // MODIFICATION: UNREAD TRACKING
    // ============================================================
    isRead: {
      type: Boolean,
      default: false,
      index: true, // Indexed for fast "count unread" queries
    },
  },
  { timestamps: true }
);

/**
 * Validation: A message must contain either a text body or a file attachment.
 */
messageSchema.path('text').validate(function () {
  const hasText =
    typeof this.text === 'string' && this.text.trim().length > 0;
  const hasFileUrl =
    typeof this.fileUrl === 'string' && this.fileUrl.trim().length > 0;

  return hasText || hasFileUrl;
}, 'Message must have either text or a file attachment');

// Compound indexes for optimized chat retrieval and inbox counts
messageSchema.index({ task: 1, createdAt: 1 });
messageSchema.index({ task: 1, student: 1, createdAt: 1 });
messageSchema.index({ sender: 1, receiver: 1, createdAt: -1 });

// Index for getting unread counts per user per task
messageSchema.index({ receiver: 1, isRead: 1, task: 1 });

module.exports = mongoose.model('Message', messageSchema);