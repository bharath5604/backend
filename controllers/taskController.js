const Task = require('../models/Task');
const User = require('../models/User');

exports.createTask = async (req, res) => {
  if(req.user.role !== 'client') return res.status(403).json({ message: 'Forbidden' });
  try {
    const task = await Task.create({ ...req.body, client: req.user.id });
    res.json(task);
  } catch(err) {
    res.status(400).json({ message: 'Error creating task', error: err.message });
  }
};

exports.getAllTasks = async (req, res) => {
  const tasks = await Task.find({ status: 'open' }).populate('client','name email');
  res.json(tasks);
};

exports.submitWork = async (req,res) => {
  const { fileUrl } = req.body;
  const task = await Task.findById(req.params.taskId);
  if(task.status !== 'assigned') return res.status(400).json({ message:'Task not assigned' });
  task.submission = { fileUrl, student: req.user.id, approved:false };
  await task.save();
  res.json(task);
};

exports.approveWork = async (req,res) => {
  const task = await Task.findById(req.params.taskId);
  if(req.user.id !== task.client.toString()) return res.status(403).json({ message:'Forbidden' });
  task.submission.approved = true;
  task.status = 'completed';
  await task.save();

  const student = await User.findById(task.submission.student);
  student.wallet += task.budget;
  await student.save();

  res.json({ task, studentWallet: student.wallet });
};

exports.rateStudent = async (req,res) => {
  const { rating } = req.body;
  const task = await Task.findById(req.params.taskId);
  task.rating = rating;
  await task.save();
  res.json(task);
};
