// models/Message.js
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Text is now optional because a message can be "file only"
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

// Auto-delete messages 24 hours after creation
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('Message', messageSchema);
