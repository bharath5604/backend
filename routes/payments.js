const express = require('express');
const router = express.Router();
const Payment = require('../models/Payment');
const User = require('../models/User');

// TODO: import and configure Stripe/Razorpay SDK here using process.env keys
// const razorpay = new Razorpay({ ... });
// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Razorpay webhook endpoint example
router.post('/webhook/razorpay', express.json(), async (req, res) => {
  try {
    const payload = req.body;

    // TODO: verify signature with process.env.RZP_WEBHOOK_SECRET
    // const signature = req.headers['x-razorpay-signature'];
    // razorpay.validateWebhookSignature(JSON.stringify(payload), signature, process.env.RZP_WEBHOOK_SECRET);

    const event = payload.event;
    const entity = payload.payload && payload.payload.payment && payload.payload.payment.entity;

    if (!entity || !entity.order_id) {
      return res.status(400).json({ message: 'Invalid webhook payload' });
    }

    // Find payment by gatewayOrderId
    const payment = await Payment.findOne({ gatewayOrderId: entity.order_id });
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found for order' });
    }

    if (event === 'payment.captured') {
      payment.status = 'released';
      payment.gatewayPaymentId = entity.id;
      await payment.save();

      // On success: credit netToStudent to student wallet
      const student = await User.findById(payment.student);
      if (student) {
        student.wallet = (student.wallet || 0) + (payment.netToStudent || 0);
        await student.save();
      }

      // Optionally track client fee usage; wallet not reduced here,
      // but you could add a invoices/fees collection if needed.

    } else if (event === 'payment.failed') {
      payment.status = 'failed';
      await payment.save();
    }

    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ message: 'Webhook error', error: err.message });
  }
});

module.exports = router;
