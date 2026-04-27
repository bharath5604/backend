// backend/models/Payment.js
const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // CRITICAL FIX: Remove 'required: true' from bid
  bid: { type: mongoose.Schema.Types.ObjectId, ref: 'Bid' }, 

  totalBudget: { type: Number, required: true },
  netToStudent: { type: Number, required: true },

  advance: {
    amount: Number,
    status: { type: String, enum: ['pending', 'paid'], default: 'pending' }
  },
  final: {
    amount: Number,
    status: { type: String, enum: ['pending', 'paid'], default: 'pending' }
  },
  status: { 
    type: String, 
    enum: ['created', 'awaiting_advance', 'partially_paid', 'fully_paid', 'released', 'completed'], 
    default: 'created' 
  }
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);