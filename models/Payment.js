const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
    bid: { type: mongoose.Schema.Types.ObjectId, ref: 'Bid', required: true },
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

    // Status with simple lifecycle
    status: {
      type: String,
      enum: ['created', 'held', 'completed', 'cancelled', 'released'],
      default: 'created',
    },

    // Optional manual notes, e.g., “paid offline on UPI” etc.
    declineReason: { type: String },

    // Optional gateway info
    gateway: { type: String, default: 'razorpay' },
    gatewayOrderId: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
