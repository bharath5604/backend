// backend/models/Payment.js
const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    /**
     * REFERENCES (RESTORED)
     */
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
    },
    bid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bid',
      required: true, // Preserving original logic requiring a bid
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

    /**
     * AMOUNTS & FEES (RESTORED & EXPANDED)
     */
    amount: { type: Number, required: true }, // Full task budget
    currency: { type: String, default: 'INR' },
    
    // Original fee logic preserved
    platformFeeClient: { type: Number, default: 0 },
    platformFeeStudent: { type: Number, default: 0 },

    // Total net amount that student receives into virtual wallet after both phases
    netToStudent: { type: Number, required: true },

    /**
     * PHASE 1: ADVANCE PAYMENT (20%)
     */
    advance: {
      amount: { type: Number }, // Set as 20% of total
      orderId: { type: String }, // Razorpay Order ID for Phase 1
      paymentId: { type: String }, // Razorpay Payment ID after success
      status: { 
        type: String, 
        enum: ['pending', 'paid', 'refunded'], 
        default: 'pending' 
      },
      method: { 
        type: String, 
        enum: ['razorpay', 'manual'], 
        default: 'razorpay' 
      },
      paidAt: { type: Date }
    },

    /**
     * PHASE 2: FINAL PAYMENT (80%)
     */
    final: {
      amount: { type: Number }, // Set as 80% of total
      orderId: { type: String }, // Razorpay Order ID for Phase 2
      paymentId: { type: String },
      status: { 
        type: String, 
        enum: ['pending', 'paid'], 
        default: 'pending' 
      },
      method: { 
        type: String, 
        enum: ['razorpay', 'manual'], 
        default: 'razorpay' 
      },
      paidAt: { type: Date }
    },

    /**
     * OVERALL LEDGER STATUS (RESTORED & EXPANDED)
     * 
     * created         - Payment object initialized
     * awaiting_advance - Waiting for client to pay 20%
     * partially_paid  - 20% advance received, work in progress
     * fully_paid      - 100% received, stored in platform account
     * released        - Admin released funds to student virtual wallet
     * cancelled       - Payment voided
     * declined        - Work rejected; no payout
     */
    status: {
      type: String,
      enum: [
        'created', 
        'awaiting_advance', 
        'partially_paid', 
        'fully_paid', 
        'released', 
        'cancelled', 
        'declined', 
        'completed'
      ],
      default: 'created',
    },

    // Timestamp when Admin releases money to Student Wallet
    releasedAt: {
      type: Date,
    },

    // Metadata for manual verification (e.g., "Verified UPI Ref #12345")
    adminNote: { type: String },
    
    // Reason if payment is cancelled or declined
    declineReason: { type: String },

    // Gateway Info (RESTORED)
    gateway: { type: String, default: 'razorpay' },
  },
  { timestamps: true }
);

/**
 * PRE-SAVE HOOK (RESTORED)
 * Keep releasedAt in sync with status
 */
paymentSchema.pre('save', function (next) {
  if (!this.isModified('status')) return next();

  if (this.status === 'released' || this.status === 'completed') {
    this.releasedAt = this.releasedAt || new Date();
  } else if (this.status !== 'released') {
    // If status is moved away from released, clear the date
    this.releasedAt = undefined;
  }
  next();
});

module.exports = mongoose.model('Payment', paymentSchema);