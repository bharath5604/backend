// models/Payment.js

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
    },
    bid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bid',
      required: true,
    },
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Full task amount (before platform fees) – proposed by client
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },

    // Platform fees (split between client and student)
    platformFeeClient: { type: Number, default: 0 },
    platformFeeStudent: { type: Number, default: 0 },

    // Net amount that should go to the student (based on student's bid)
    netToStudent: { type: Number, required: true },

    // Status lifecycle
    // created   -> payment object created
    // held      -> bid accepted by client, waiting for client approval of work
    // approved  -> client approved task, waiting for admin release
    // released  -> admin released funds to student
    // cancelled -> payment voided
    status: {
      type: String,
      enum: ['created', 'held', 'approved', 'released', 'cancelled'],
      default: 'created',
    },

    // When funds were actually released to student (for growth charts)
    releasedAt: {
      type: Date,
    },

    // Optional manual notes, e.g., “paid offline on UPI” etc.
    declineReason: { type: String },

    // Optional gateway info
    gateway: { type: String, default: 'razorpay' },
    gatewayOrderId: { type: String },
  },
  { timestamps: true }
);

// Keep releasedAt in sync with status (promise style: no next)
paymentSchema.pre('save', function () {
  if (!this.isModified('status')) return;

  if (this.status === 'released') {
    this.releasedAt = this.releasedAt || new Date();
  } else {
    this.releasedAt = undefined;
  }
});

module.exports = mongoose.model('Payment', paymentSchema);
