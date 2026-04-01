// // models/TaskRequest.js
// const mongoose = require('mongoose');

// const taskRequestSchema = new mongoose.Schema(
//   {
//     task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
//     client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
//     student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
//     message: { type: String, default: '' },
//     status: {
//       type: String,
//       enum: ['pending', 'accepted', 'declined', 'cancelled','selected'],
//       default: 'pending',
//     },
//   },
//   { timestamps: true }
// );

// module.exports = mongoose.model('TaskRequest', taskRequestSchema);