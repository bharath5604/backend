// // backend/models/Payment.js
// const mongoose = require('mongoose');

// const paymentSchema = new mongoose.Schema({
//   /**
//    * CORE LINKS
//    */
//   task: { 
//     type: mongoose.Schema.Types.ObjectId, 
//     ref: 'Task', 
//     required: true 
//   },
//   client: { 
//     type: mongoose.Schema.Types.ObjectId, 
//     ref: 'User', 
//     required: true 
//   },
//   student: { 
//     type: mongoose.Schema.Types.ObjectId, 
//     ref: 'User', 
//     required: true 
//   },
  
//   // Optional: Link to a specific bid if your workflow uses them
//   bid: { 
//     type: mongoose.Schema.Types.ObjectId, 
//     ref: 'Bid' 
//   }, 

//   /**
//    * FINANCIAL DATA
//    */
//   totalBudget: { 
//     type: Number, 
//     required: true 
//   },
//   netToStudent: { 
//     type: Number, 
//     required: true 
//   },

//   /**
//    * PHASE 1: 20% ADVANCE
//    */
//   advance: {
//     amount: { type: Number },
//     status: { 
//         type: String, 
//         enum: ['pending', 'paid'], 
//         default: 'pending' 
//     },
//     method: { 
//         type: String, 
//         enum: ['none', 'manual', 'razorpay'], 
//         default: 'none' 
//     },
//     paidAt: { type: Date },
//     orderId: { type: String },    // Razorpay Order ID
//     paymentId: { type: String }   // Razorpay Transaction ID
//   },

//   /**
//    * PHASE 2: 80% FINAL BALANCE
//    */
//   final: {
//     amount: { type: Number },
//     status: { 
//         type: String, 
//         enum: ['pending', 'paid'], 
//         default: 'pending' 
//     },
//     method: { 
//         type: String, 
//         enum: ['none', 'manual', 'razorpay'], 
//         default: 'none' 
//     },
//     paidAt: { type: Date },
//     orderId: { type: String },    // Razorpay Order ID
//     paymentId: { type: String }   // Razorpay Transaction ID
//   },

//   /**
//    * OVERALL LEDGER STATUS
//    */
//   status: { 
//     type: String, 
//     enum: [
//         'created', 
//         'awaiting_advance', 
//         'approved',
//         'partially_paid', 
//         'fully_paid', 
//         'released', 
//         'completed'
//     ], 
//     default: 'created' 
//   },

//   /**
//    * ADMIN AUDIT TRAIL
//    */
//   adminNote: {
//     type: String,
//     default: ''
//   },
  
//   releasedAt: {
//     type: Date
//   }

// }, { timestamps: true });

// module.exports = mongoose.model('Payment', paymentSchema);