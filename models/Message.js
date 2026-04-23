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
  },
  { timestamps: true }
);

messageSchema.path('text').validate(function () {
  const hasText =
    typeof this.text === 'string' && this.text.trim().length > 0;
  const hasFileUrl =
    typeof this.fileUrl === 'string' && this.fileUrl.trim().length > 0;

  return hasText || hasFileUrl;
}, 'Message must have either text or a file attachment');

messageSchema.index({ task: 1, createdAt: 1 });
messageSchema.index({ task: 1, student: 1, createdAt: 1 });
messageSchema.index({ sender: 1, receiver: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);