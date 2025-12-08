const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
    bid: { type: mongoose.Schema.Types.ObjectId, ref: 'Bid', required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    amount: { type: Number, required: true },          // gross task amount
    currency: { type: String, default: 'INR' },

    platformFeeClient: { type: Number, default: 0 },   // 0.5% of amount
    platformFeeStudent: { type: Number, default: 0 },  // 0.5% of amount
    netToStudent: { type: Number, default: 0 },        // amount - both fees

    status: {
      type: String,
      enum: ['created', 'held', 'released', 'declined', 'failed'],
      default: 'created',
    },

    gateway: { type: String, enum: ['razorpay', 'stripe'], default: 'razorpay' },
    gatewayOrderId: { type: String },
    gatewayPaymentId: { type: String },
    gatewaySignature: { type: String },

    declineReason: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
