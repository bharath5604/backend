// backend/routes/payments.js
const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');

const Task = require('../models/Task');
const User = require('../models/User');
const Payment = require('../models/Payment');
const verifyJWT = require('../middleware/authMiddleware');
const { sendNotification } = require('../utils/fcm');

// Initialize Razorpay Instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'PLACEHOLDER',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'PLACEHOLDER',
});

/**
 * POST /api/payments/create-order
 * Triggered by Client App to start a payment session.
 * body: { taskId, type: 'advance' | 'final' }
 */
router.post('/create-order', verifyJWT, async (req, res) => {
  try {
    const { taskId, type } = req.body;

    if (!['advance', 'final'].includes(type)) {
      return res.status(400).json({ message: 'Invalid payment type' });
    }

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    // Calculate amount based on phase
    // Razorpay expects amount in PAISE (₹1 = 100 paise)
    const amount = type === 'advance' ? (task.budget * 0.20) : (task.budget * 0.80);
    
    const options = {
      amount: Math.round(amount * 100), 
      currency: "INR",
      receipt: `receipt_${taskId}_${type}_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    // Update or Create the Payment Ledger in MongoDB
    let paymentRecord = await Payment.findOne({ task: taskId });
    
    if (!paymentRecord) {
      // Note: In your workflow, the Payment object is usually created 
      // when the student accepts the invitation.
      return res.status(404).json({ message: 'Payment record not initialized' });
    }

    if (type === 'advance') {
      paymentRecord.advance.amount = amount;
      paymentRecord.advance.orderId = order.id;
      paymentRecord.status = 'awaiting_advance';
    } else {
      paymentRecord.final.amount = amount;
      paymentRecord.final.orderId = order.id;
    }

    await paymentRecord.save();

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID // Send key to frontend
    });

  } catch (err) {
    console.error('Razorpay Order Error:', err);
    return res.status(500).json({ message: 'Could not initiate payment session' });
  }
});

/**
 * POST /api/payments/webhook
 * AUTOMATIC: Hit by Razorpay servers instantly when payment is successful.
 * This makes the system "Real-Time".
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];

  try {
    // 1. Verify that the request actually came from Razorpay
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      return res.status(400).send('Invalid webhook signature');
    }

    const event = req.body.event;
    const payload = req.body.payload.payment.entity;

    // 2. Process Successful Payment
    if (event === 'payment.captured') {
      const orderId = payload.order_id;
      
      // Find which payment record this belongs to
      const paymentRecord = await Payment.findOne({
        $or: [{ 'advance.orderId': orderId }, { 'final.orderId': orderId }]
      });

      if (paymentRecord) {
        const task = await Task.findById(paymentRecord.task);
        const student = await User.findById(paymentRecord.student);

        if (orderId === paymentRecord.advance.orderId) {
          /** 
           * PHASE 1 COMPLETE: 20% Advance Received 
           * Action: Move task to 'assigned' so student can start.
           */
          paymentRecord.advance.status = 'paid';
          paymentRecord.advance.paymentId = payload.id;
          paymentRecord.advance.paidAt = new Date();
          paymentRecord.status = 'partially_paid';
          
          task.status = 'assigned';

          await sendNotification(student._id, {
            title: 'Payment Received!',
            body: `20% advance for "${task.title}" is paid. You can now start the work.`,
            data: { type: 'task_assigned', taskId: task._id.toString() }
          });

        } else if (orderId === paymentRecord.final.orderId) {
          /** 
           * PHASE 2 COMPLETE: 80% Final Received 
           * Action: Task is 'completed'. Credit Student virtual wallet.
           */
          paymentRecord.final.status = 'paid';
          paymentRecord.final.paymentId = payload.id;
          paymentRecord.final.paidAt = new Date();
          paymentRecord.status = 'completed';
          
          task.status = 'completed';

          // Credit Student Wallet (Instantly)
          // We credit the 'netToStudent' amount (total budget minus fees)
          student.wallet += (paymentRecord.netToStudent || task.budget);
          student.tasksCompleted += 1;
          await student.save();

          await sendNotification(student._id, {
            title: 'Earnings Credited!',
            body: `Final payment for "${task.title}" received. ₹${paymentRecord.netToStudent} added to your wallet.`,
            data: { type: 'payment_received', taskId: task._id.toString() }
          });
        }

        await paymentRecord.save();
        await task.save();
      }
    }

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).send('Webhook Processing Failed');
  }
});

module.exports = router;