const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
    bid: { type: mongoose.Schema.Types.ObjectId, ref: 'Bid', required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Full task amount (no platform fee cuts)
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },

    // Direct net to student (same as amount when you credit it)
    netToStudent: { type: Number, default: 0 },

    // Simple status just for bookkeeping (no escrow / hold logic)
    status: {
      type: String,
      enum: ['created', 'completed', 'cancelled'],
      default: 'created',
    },

    // Optional manual notes, e.g., “paid offline on UPI” etc.
    declineReason: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
