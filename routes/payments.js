const express = require('express');
const router = express.Router();

// For now we are not using any automatic payment gateway or webhooks.
// This file is kept as a placeholder so the route can exist without doing anything.

router.post('/webhook/razorpay', express.json(), async (req, res) => {
  // Auto payment processing is disabled for now.
  // You can log or store payloads here later if you re‑enable Razorpay.
  return res.status(200).json({ received: true, message: 'Auto payment is currently disabled.' });
});

module.exports = router;
