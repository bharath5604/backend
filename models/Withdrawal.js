// // backend/models/Withdrawal.js
// const mongoose = require('mongoose');

// const withdrawalSchema = new mongoose.Schema({
//   student: { 
//     type: mongoose.Schema.Types.ObjectId, 
//     ref: 'User', 
//     required: true 
//   },
//   amount: { 
//     type: Number, 
//     required: true,
//     min: [500, 'Minimum withdrawal is ₹500']
//   },
//   // Snapshot of bank details at time of request
//   bankSnapshot: {
//     accountHolderName: String,
//     bankName: String,
//     accountNumber: String,
//     ifscCode: String
//   },
//   /**
//    * pending   - Student requested, admin hasn't sent money yet
//    * processed - Admin sent the real bank transfer
//    * rejected  - Admin denied request (money refunded to app wallet)
//    */
//   status: { 
//     type: String, 
//     enum: ['pending', 'processed', 'rejected'], 
//     default: 'pending' 
//   },
//   adminNote: String, // e.g., "Ref #992211 sent via IMPS"
//   processedAt: Date
// }, { timestamps: true });

// module.exports = mongoose.model('Withdrawal', withdrawalSchema);