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
const { sendNotification } = require('../utils/fcm'); // Enhanced with VPS Socket support

// =========================================================
// RAZORPAY INITIALIZATION
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
  console.warn('⚠️ Razorpay credentials missing; Auto-payments disabled.');
}

/**
 * Real-time Broadcast Helper
 */
const emitPaymentUpdate = (req, room, event, data) => {
  const io = req.app.get('socketio');
  if (io) {
    io.to(room).emit(event, data);
    // Refresh global dashboard counters
    io.emit('admin_stats_update', { timestamp: new Date() });
  }
};

/**
 * POST /api/payments/create-order
 * Triggered by Client App to start a payment session.
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

    if (!task.budgetFinalized || !task.budget) {
      return res.status(400).json({ message: 'Budget not yet finalized by Admin.' });
    }

    const options = {
      amount: Math.round(task.budget * 100), // INR to Paise
      currency: "INR",
      receipt: `receipt_${taskId}_${Date.now()}`,
      payment_capture: 1 
    };

    const order = await razorpay.orders.create(options);

    let paymentRecord = await Payment.findOne({ task: taskId });
    if (!paymentRecord) {
        paymentRecord = new Payment({
            task: taskId,
            client: task.client,
            student: task.student,
            totalBudget: task.budget,
            netToStudent: task.budget
        });
    }

    paymentRecord.final.amount = task.budget;
    paymentRecord.final.orderId = order.id;
    paymentRecord.status = 'awaiting_payment';

    await paymentRecord.save();

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: key_id 
    });

  } catch (err) {
    console.error('Razorpay Order Error:', err);
    return res.status(500).json({ message: 'Could not initiate payment session' });
  }
});

/**
 * POST /api/payments/webhook
 * AUTOMATIC: Secure verification triggered by Razorpay servers.
 */
router.post('/webhook', async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];

  if (!secret || !signature) {
    return res.status(200).json({ status: 'ignored', message: 'Webhook secret missing' });
  }

  try {
    // SECURITY: Verify that this request actually came from Razorpay
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      console.error("❌ Webhook Signature Mismatch");
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

        // Update Task and status
        task.adminReceivedPayment = true; 
        task.status = 'completed';
        task.clientCanDownload = true; // Auto-unlock deliverables

        paymentRecord.final.status = 'paid';
        paymentRecord.final.paymentId = payload.id;
        paymentRecord.final.paidAt = new Date();
        paymentRecord.final.method = 'razorpay';
        paymentRecord.status = 'completed';

        // Credit Student Virtual Wallet
        if (student) {
          const creditAmount = paymentRecord.netToStudent || task.budget;
          student.wallet = (student.wallet || 0) + creditAmount;
          student.tasksCompleted += 1;
          await student.save();
          
          // Notify Student Dashboard to update points live
          emitPaymentUpdate(req, student._id.toString(), 'feedback_update', { 
            walletBalance: student.wallet 
          });
        }
        
        await paymentRecord.save();
        await task.save();

        // ============================================================
        // REAL-TIME NOTIFICATIONS (VPS SOCKETS + MONGODB MESSENGER)
        // ============================================================
        
        // 1. Notify Client Thread Room (Refresh Task Card)
        emitPaymentUpdate(req, `${task._id}_client`, 'task_update', { 
            taskId: task._id, 
            adminReceivedPayment: true,
            clientCanDownload: true,
            status: 'completed'
        });

        // 2. Notify Admin Global Room
        emitPaymentUpdate(req, 'admin_room', 'task_update', { taskId: task._id });

        // 3. Send MongoDB + Socket + FCM Notifications
        if (task.client) {
            // MODIFICATION: Added 'req' to pass to the MongoDB Notification System
            await sendNotification(task.client.toString(), {
                title: "Payment Verified!",
                body: `Your payment for "${task.title}" is confirmed. Downloads are now unlocked.`,
                data: { type: "payment_needed", taskId: task._id.toString() }
            }, req); 
        }

        if (student) {
            // MODIFICATION: Added 'req' to pass to the MongoDB Notification System
            await sendNotification(student._id.toString(), {
                title: "Earnings Credited",
                body: `Payment for "${task.title}" has been added to your virtual wallet.`,
                data: { type: "payment_received", taskId: task._id.toString() }
            }, req);
        }
      }
    }

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).send('Webhook Error');
  }
});

module.exports = router;