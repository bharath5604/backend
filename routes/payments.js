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

// Only initialize if real keys are provided to prevent "mandatory key_id" crash
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
  console.warn('⚠️ Razorpay credentials missing. Auto-payments disabled. Defaulting to manual workflow.');
}

/**
 * POST /api/payments/create-order
 * Triggered by Client App to start a payment session.
 * body: { taskId, type: 'advance' | 'final' }
 */
router.post('/create-order', verifyJWT, async (req, res) => {
  try {
    // FAIL-SAFE: Check if gateway is active
    if (!isRazorpayActive) {
      return res.status(503).json({ 
        message: 'Automatic payment gateway is currently unavailable. Please contact Admin for manual payment (UPI/Bank Transfer).' 
      });
    }

    const { taskId, type } = req.body;

    if (!['advance', 'final'].includes(type)) {
      return res.status(400).json({ message: 'Invalid payment type' });
    }

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    // Calculate amount based on phase (20% or 80%)
    const amount = type === 'advance' ? (task.budget * 0.20) : (task.budget * 0.80);
    
    const options = {
      amount: Math.round(amount * 100), // paise
      currency: "INR",
      receipt: `receipt_${taskId}_${type}_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    // Update or Create the Payment Ledger in MongoDB
    let paymentRecord = await Payment.findOne({ task: taskId });
    
    if (!paymentRecord) {
      return res.status(404).json({ message: 'Payment record not found' });
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
      keyId: process.env.RAZORPAY_KEY_ID
    });

  } catch (err) {
    console.error('Razorpay Order Error:', err);
    return res.status(500).json({ message: 'Could not initiate payment session' });
  }
});

/**
 * POST /api/payments/webhook
 * AUTOMATIC: Hit by Razorpay servers instantly when payment is successful.
 */
router.post('/webhook', async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];

  // FAIL-SAFE: If no secret is set, ignore webhooks to prevent errors
  if (!secret || !signature) {
    return res.status(200).json({ status: 'ignored', message: 'Webhook secret not configured' });
  }

  try {
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      return res.status(400).send('Invalid webhook signature');
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

        if (orderId === paymentRecord.advance.orderId) {
          /** PHASE 1: 20% Paid */
          paymentRecord.advance.status = 'paid';
          paymentRecord.advance.paymentId = payload.id;
          paymentRecord.advance.paidAt = new Date();
          paymentRecord.advance.method = 'razorpay';
          paymentRecord.status = 'partially_paid';
          task.status = 'assigned';

          await sendNotification(student._id, {
            title: 'Project Activated',
            body: `Advance for "${task.title}" received. You can now start the work.`,
            data: { type: 'task_assigned', taskId: task._id.toString() }
          });

        } else if (orderId === paymentRecord.final.orderId) {
          /** PHASE 2: 80% Paid */
          paymentRecord.final.status = 'paid';
          paymentRecord.final.paymentId = payload.id;
          paymentRecord.final.paidAt = new Date();
          paymentRecord.final.method = 'razorpay';
          paymentRecord.status = 'completed';
          task.status = 'completed';

          // Automatically credit Student virtual wallet
          student.wallet += (paymentRecord.netToStudent || task.budget);
          student.tasksCompleted += 1;
          await student.save();

          await sendNotification(student._id, {
            title: 'Earnings Credited',
            body: `Final payment for "${task.title}" received. Check your wallet!`,
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
    return res.status(500).send('Internal Error');
  }
});

module.exports = router;