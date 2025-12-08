const Bid = require('../models/Bid');
const Task = require('../models/Task');

exports.submitBid = async (req,res) => {
  if(req.user.role !== 'student') return res.status(403).json({ message:'Forbidden' });
  try {
    const bid = await Bid.create({ ...req.body, student: req.user.id });
    res.json({ message:'Bid submitted', bid });
  } catch(err) {
    res.status(400).json({ message:'Error submitting bid', error: err.message });
  }
};

exports.acceptBid = async (req,res) => {
  if(req.user.role !== 'client') return res.status(403).json({ message:'Forbidden' });
  try {
    const bid = await Bid.findByIdAndUpdate(req.params.bidId, { status:'accepted' }, { new:true });
    await Task.findByIdAndUpdate(bid.task, { status:'assigned' });
    res.json({ message:'Bid accepted', bid });
  } catch(err) {
    res.status(400).json({ message:'Error accepting bid', error: err.message });
  }
};
