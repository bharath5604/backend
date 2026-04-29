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

/**
 * We only initialize the SDK if real keys are provided.
 * This prevents the "Error: key_id is mandatory" crash on environments 
 * where keys are not yet configured (like a fresh Render deploy).
 */
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
  console.warn('⚠️ Razorpay credentials missing or invalid. Auto-payments disabled. Defaulting to manual workflow.');
}

/**
 * POST /api/payments/create-order
 * Triggered by Client App to start a payment session.
 * body: { taskId, type: 'advance' | 'final' }
 */
router.post('/create-order', verifyJWT, async (req, res) => {
  try {
    // FAIL-SAFE: If Razorpay isn't configured, prevent the crash and inform the user
    if (!isRazorpayActive || !razorpay) {
      return res.status(503).json({ 
        message: 'Automatic payment gateway is currently unavailable. Please contact Admin for manual payment details (UPI/Bank Transfer).' 
      });
    }

    const { taskId, type } = req.body;

    if (!['advance', 'final'].includes(type)) {
      return res.status(400).json({ message: 'Invalid payment type' });
    }

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    // Calculate amount based on phase (20% or 80%)
    // Note: Razorpay expects amount in PAISE (₹1 = 100 paise)
    const amount = type === 'advance' ? (task.budget * 0.20) : (task.budget * 0.80);
    
    const options = {
      amount: Math.round(amount * 100), 
      currency: "INR",
      receipt: `receipt_${taskId}_${type}_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    // Update the Payment Ledger in MongoDB
    let paymentRecord = await Payment.findOne({ task: taskId });
    
    if (!paymentRecord) {
      return res.status(404).json({ message: 'Payment record not found' });
    }

    if (type === 'advance') {
      paymentRecord.advance.amount = amount;
      paymentRecord.advance.orderId = order.id;
      // We don't change task status yet; that happens after payment success
    } else {
      paymentRecord.final.amount = amount;
      paymentRecord.final.orderId = order.id;
    }

    await paymentRecord.save();

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID // Required by Flutter SDK
    });

  } catch (err) {
    console.error('Razorpay Order Error:', err);
    return res.status(500).json({ message: 'Could not initiate payment session' });
  }
});

/**
 * POST /api/payments/webhook
 * AUTOMATIC: Hit by Razorpay servers instantly when payment is successful.
 * This manages the automated workflow transitions.
 */
router.post('/webhook', async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];

  // FAIL-SAFE: If no secret is set, ignore webhooks to prevent processing errors
  if (!secret || !signature) {
    return res.status(200).json({ status: 'ignored', message: 'Webhook secret not configured' });
  }

  try {
    /**
     * Verification Logic:
     * We use the raw request body to verify the signature.
     * Note: This assumes app.use(express.raw) or similar is used in server.js 
     * specifically for this route to preserve the original string formatting.
     */
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      return res.status(400).send('Invalid webhook signature');
    }

    const event = req.body.event;
    const payload = req.body.payload.payment.entity;

    // We react to captured payments
    if (event === 'payment.captured') {
      const orderId = payload.order_id;
      
      // Find the specific ledger phase (Advance or Final) associated with this Order ID
      const paymentRecord = await Payment.findOne({
        $or: [{ 'advance.orderId': orderId }, { 'final.orderId': orderId }]
      });

      if (paymentRecord) {
        const task = await Task.findById(paymentRecord.task);
        const student = await User.findById(paymentRecord.student);

        if (orderId === paymentRecord.advance.orderId) {
          /** PHASE 1 COMPLETE: 20% Advance Received */
          paymentRecord.advance.status = 'paid';
          paymentRecord.advance.paymentId = payload.id;
          paymentRecord.advance.paidAt = new Date();
          paymentRecord.advance.method = 'razorpay';
          paymentRecord.status = 'partially_paid';
          
          // Work can now begin
          task.status = 'assigned';

          await sendNotification(student._id, {
            title: 'Task Activated',
            body: `Advance for "${task.title}" received. You can now start the work.`,
            data: { type: 'task_assigned', taskId: task._id.toString() }
          });

        } else if (orderId === paymentRecord.final.orderId) {
          /** PHASE 2 COMPLETE: 80% Final Received */
          paymentRecord.final.status = 'paid';
          paymentRecord.final.paymentId = payload.id;
          paymentRecord.final.paidAt = new Date();
          paymentRecord.final.method = 'razorpay';
          paymentRecord.status = 'completed';
          
          // Project is officially finished
          task.status = 'completed';

          // AUTOMATIC STUDENT WALLET CREDIT
          // Credit the 'netToStudent' amount (usually task budget minus SKILEN platform fees)
          const amountToCredit = paymentRecord.netToStudent || task.budget;
          student.wallet += amountToCredit;
          student.tasksCompleted += 1;
          await student.save();

          await sendNotification(student._id, {
            title: 'Earnings Credited',
            body: `Final payment for "${task.title}" received. Check your virtual wallet!`,
            data: { type: 'payment_received', taskId: task._id.toString() }
          });
        }

        await paymentRecord.save();
        await task.save();
      }
    }

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error('Webhook Logic Error:', err);
    return res.status(500).send('Internal Processing Error');
  }
});

module.exports = router;