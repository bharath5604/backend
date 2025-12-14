const express = require('express');
const router = express.Router();

const Bid = require('../models/Bid');
const Task = require('../models/Task');
const Payment = require('../models/Payment');
const verifyJWT = require('../middleware/authMiddleware');
const Joi = require('joi');
const { sendNotification } = require('../utils/fcm');

// Joi schema for submitting a bid
const submitBidSchema = Joi.object({
  task: Joi.string().required(),
  quote: Joi.number().positive().max(1_000_000).required(),
  timeline: Joi.string().max(200).required(),
  message: Joi.string().max(2000).allow('', null),
});

// Submit bid (student)
router.post('/submit', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const { error, value } = submitBidSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const bid = await Bid.create({
      task: value.task,
      quote: value.quote,
      timeline: value.timeline,
      message: value.message || '',
      student: req.user.id,
    });

    // Notify client about new bid
    const task = await Task.findById(value.task).select('client title');
    if (task) {
      await sendNotification(task.client, {
        title: 'New bid received',
        body: `Your task "${task.title}" has a new bid`,
        data: {
          type: 'bid_new',
          taskId: task._id.toString(),
          bidId: bid._id.toString(),
        },
      });
    }

    res.json({ message: 'Bid submitted', bid });
  } catch (err) {
    res
      .status(400)
      .json({ message: 'Error submitting bid', error: err.message });
  }
});

// Accept bid (client) -> create Payment with fees
router.post('/accept/:bidId', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const bid = await Bid.findById(req.params.bidId);
    if (!bid) return res.status(404).json({ message: 'Bid not found' });

    const task = await Task.findById(bid.task);
    if (!task) {
      return res.status(404).json({ message: 'Task not found for bid' });
    }
    if (task.client.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not your task' });
    }

    bid.status = 'accepted';
    await bid.save();

    task.status = 'assigned';
    task.student = bid.student;   // CHANGED: link accepted student here
    await task.save();

    const amount = task.budget || bid.quote || 0;
    const platformFeeClient = +(amount * 0.005).toFixed(2); // 0.5%
    const platformFeeStudent = +(amount * 0.005).toFixed(2); // 0.5%
    const netToStudent = +(
      amount -
      platformFeeClient -
      platformFeeStudent
    ).toFixed(2);

    const payment = await Payment.create({
      task: task._id,
      bid: bid._id,
      client: req.user.id,
      student: bid.student,
      amount,
      currency: 'INR',
      platformFeeClient,
      platformFeeStudent,
      netToStudent,
      status: 'held', // held until approval
      gateway: 'razorpay',
    });

    // Mock order object (replace with real gateway integration later)
    const order = {
      id: `order_${payment._id}`,
      amount: Math.round(amount * 100),
      currency: 'INR',
    };

    payment.gatewayOrderId = order.id;
    await payment.save();

    // Notify student that bid is accepted
    await sendNotification(bid.student, {
      title: 'Bid accepted',
      body: 'Your bid has been accepted. Please start working on the task.',
      data: {
        type: 'bid_accepted',
        taskId: task._id.toString(),
        bidId: bid._id.toString(),
      },
    });

    res.json({
      message: 'Bid accepted, payment created',
      bid,
      payment,
      order,
    });
  } catch (err) {
    res
      .status(400)
      .json({ message: 'Error accepting bid', error: err.message });
  }
});

// Decline bid (client)
router.post('/decline/:bidId', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const bid = await Bid.findById(req.params.bidId).populate('task');
    if (!bid) return res.status(404).json({ message: 'Bid not found' });

    if (!bid.task || bid.task.client.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not your task' });
    }

    bid.status = 'rejected';
    await bid.save();

    await sendNotification(bid.student, {
      title: 'Bid declined',
      body: `Your bid on "${bid.task.title}" was declined.`,
      data: {
        type: 'bid_declined',
        taskId: bid.task._id.toString(),
        bidId: bid._id.toString(),
      },
    });

    res.json({ message: 'Bid declined', bid });
  } catch (err) {
    res
      .status(400)
      .json({ message: 'Error declining bid', error: err.message });
  }
});

// Get all bids on this client's tasks
router.get('/my', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const tasks = await Task.find({ client: req.user.id }).select('_id');
    const taskIds = tasks.map((t) => t._id);

    const bids = await Bid.find({ task: { $in: taskIds } })
      .populate('student', 'name email')
      .populate('task', 'title');

    res.json(bids);
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error fetching bids', error: err.message });
  }
});

// Get bids for a specific task (client view)
router.get('/task/:taskId', verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const task = await Task.findById(req.params.taskId).select('client title');
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (task.client.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not your task' });
    }

    const bids = await Bid.find({ task: task._id })
      .populate('student', 'name email')
      .sort({ createdAt: -1 });

    res.json({ task, bids });
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Error fetching task bids', error: err.message });
  }
});

module.exports = router;
