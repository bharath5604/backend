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

// =========================================================
// RAZORPAY INITIALIZATION (FAIL-SAFE LOGIC)
// =========================================================

const key_id = process.env.RAZORPAY_KEY_ID;
const key_secret = process.env.RAZORPAY_KEY_SECRET;

let razorpay = null;
let isRazorpayActive = false;

if (key_id && key_secret && key_id !== 'PLACEHOLDER' && key_secret !== 'PLACEHOLDER') {
  try {
    razorpay = new Razorpay({
      key_id: key_id,
      key_secret: key_secret,
    });
    isRazorpayActive = true;
    console.log('✅ Razorpay Module initialized successfully.');
  } catch (err) {
    console.error('❌ Razorpay failed to initialize:', err.message);
  }
} else {
  console.warn('⚠️ Razorpay credentials missing or invalid. Auto-payments disabled.');
}

/**
 * Real-time Broadcast Helper
 */
const emitPaymentUpdate = (req, room, event, data) => {
  const io = req.app.get('socketio');
  if (io) {
    io.to(room).emit(event, data);
    // Refresh stats for Admin Dashboard
    io.emit('admin_stats_update', { timestamp: new Date() });
  }
};

/**
 * POST /api/payments/create-order
 * Triggered by Client App to start a payment session.
 * Now enforces budgetFinalized check.
 */
router.post('/create-order', verifyJWT, async (req, res) => {
  try {
    if (!isRazorpayActive || !razorpay) {
      return res.status(503).json({ 
        message: 'Automatic payment gateway is currently unavailable. Please use manual QR method.' 
      });
    }

    const { taskId } = req.body;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    // Enforce business logic: Admin must finalize budget before Razorpay is enabled
    if (!task.budgetFinalized || !task.budget) {
      return res.status(400).json({ message: 'Budget not yet finalized by Admin. Please use manual payment or wait.' });
    }

    const options = {
      amount: Math.round(task.budget * 100), // Amount in Paise (INR * 100)
      currency: "INR",
      receipt: `receipt_${taskId}_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    // Update or Create Payment Ledger
    let paymentRecord = await Payment.findOne({ task: taskId });
    if (!paymentRecord) {
        paymentRecord = new Payment({
            task: taskId,
            client: task.client,
            student: task.student,
            totalBudget: task.budget,
            netToStudent: task.budget // Defaulting to 100% for now
        });
    }

    // Assign Order ID to the 'final' phase as requested (Lump sum at finish)
    paymentRecord.final.amount = task.budget;
    paymentRecord.final.orderId = order.id;
    paymentRecord.status = 'awaiting_payment';

    await paymentRecord.save();

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID 
    });

  } catch (err) {
    console.error('Razorpay Order Error:', err);
    return res.status(500).json({ message: 'Could not initiate payment session' });
  }
});

/**
 * POST /api/payments/webhook
 * AUTOMATIC: Triggered by Razorpay.
 * MODIFICATION: Automatically flips adminReceivedPayment to true.
 */
router.post('/webhook', async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];

  if (!secret || !signature) {
    return res.status(200).json({ status: 'ignored', message: 'Webhook secret not configured' });
  }

  try {
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      return res.status(400).send('Invalid signature');
    }

    const event = req.body.event;
    const payload = req.body.payload.payment.entity;

    if (event === 'payment.captured') {
      const orderId = payload.order_id;
      
      const paymentRecord = await Payment.findOne({
        $or: [{ 'advance.orderId': orderId }, { 'final.orderId': orderId }]
      });

      if (paymentRecord) {
        const task = await Task.findById(paymentRecord.task);
        const student = await User.findById(paymentRecord.student);

        // ============================================================
        // MODIFICATION: AUTOMATIC TASK VERIFICATION
        // ============================================================
        task.adminReceivedPayment = true; 
        task.status = 'completed';

        paymentRecord.final.status = 'paid';
        paymentRecord.final.paymentId = payload.id;
        paymentRecord.final.paidAt = new Date();
        paymentRecord.final.method = 'razorpay';
        paymentRecord.status = 'completed';

        // Credit Student Wallet
        const creditAmount = paymentRecord.netToStudent || task.budget;
        student.wallet = (student.wallet || 0) + creditAmount;
        student.tasksCompleted += 1;
        
        await student.save();
        await paymentRecord.save();
        await task.save();

        // REAL-TIME: Instantly show "Verified" status in Client/Admin apps
        emitPaymentUpdate(req, task._id.toString(), 'task_update', { 
            taskId: task._id, 
            adminReceivedPayment: true,
            status: 'completed'
        });

        // Update Student Dashboard points live
        emitPaymentUpdate(req, student._id.toString(), 'feedback_update', { 
            walletBalance: student.wallet 
        });

        // PUSH NOTIFICATIONS
        await sendNotification(task.client.toString(), {
            title: "Payment Successful",
            body: `Your payment for "${task.title}" has been verified automatically.`,
            data: { type: "payment_needed" }
        });

        await sendNotification(student._id.toString(), {
            title: "Project Payout Received",
            body: `Payment for "${task.title}" has been credited to your virtual wallet.`,
            data: { type: "payment_received" }
        });
      }
    }

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).send('Webhook Processing Error');
  }
});

module.exports = router;