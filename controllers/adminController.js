// backend/controllers/adminController.js
const User = require("../models/User");
const Task = require("../models/Task");
const Message = require("../models/Message");

const sendServerError = (res, error, fallbackMessage) => {
  return res.status(500).json({ message: error.message || fallbackMessage });
};

// --- 1. DASHBOARD & GROWTH ---
exports.getOverviewStats = async (req, res) => {
  try {
    const [uTotal, tTotal, tCom, tOpen] = await Promise.all([
      User.countDocuments({}), Task.countDocuments({}),
      Task.countDocuments({ status: "completed" }), Task.countDocuments({ status: "open" }),
    ]);
    res.json({ users: { total: uTotal }, tasks: { total: tTotal, completed: tCom, open: tOpen } });
  } catch (error) { return sendServerError(res, error, "Stats failed"); }
};

exports.getGrowthStats = async (req, res) => {
  try {
    const { metric } = req.query;
    const Model = metric === "students" ? User : Task;
    const growth = await Model.aggregate([
      { $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]);
    res.json(growth);
  } catch (error) { return sendServerError(res, error, "Growth failed"); }
};

exports.getTaskStats = async (req, res) => {
  try {
    const stats = await Task.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
    res.json({ byStatus: stats });
  } catch (error) { return sendServerError(res, error, "Task stats failed"); }
};

exports.getTopStudents = async (req, res) => {
  try {
    const top = await User.find({ role: "student" }).sort({ tasksCompleted: -1 }).limit(10);
    res.json(top);
  } catch (error) { return sendServerError(res, error, "Rankings failed"); }
};

// --- 2. FILTERS ---
exports.getTaskFilters = async (req, res) => {
  try {
    const [locs, doms] = await Promise.all([Task.distinct("location"), Task.distinct("domain")]);
    res.json({ locations: locs.filter(Boolean), domains: doms.filter(Boolean), companies: [] });
  } catch (error) { return sendServerError(res, error, "Filters failed"); }
};

// --- 3. VETTING & SEARCH ---
exports.getSuggestedStudents = async (req, res) => {
  try {
    const { skill, location } = req.query;
    const task = await Task.findById(req.params.taskId);
    let query = { role: "student", isApproved: true };
    if (skill && skill !== 'null') query.skills = { $in: [new RegExp(skill, "i")] };
    else if (task && task.requiredSkills) query.skills = { $in: task.requiredSkills };
    if (location && location !== 'null') query.location = new RegExp(location, "i");

    const candidates = await User.find(query).sort({ tasksCompleted: -1 }).lean();
    res.json(candidates);
  } catch (error) { return sendServerError(res, error, "Search failed"); }
};

// --- 4. CHAT HANDLERS ---
exports.getClientTaskMessages = async (req, res) => {
  try {
    const msgs = await Message.find({ task: req.params.taskId, student: null }).populate('sender', 'name role').sort({ createdAt: 1 });
    res.json(msgs);
  } catch (err) { res.status(500).json({ message: "Chat load failed" }); }
};

exports.getStudentTaskMessages = async (req, res) => {
  try {
    const msgs = await Message.find({ task: req.params.taskId, student: req.query.studentId }).populate('sender', 'name role').sort({ createdAt: 1 });
    res.json(msgs);
  } catch (err) { res.status(500).json({ message: "Chat load failed" }); }
};

exports.sendClientTaskMessage = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId);
    const msg = await Message.create({ task: task._id, sender: req.user.id, receiver: task.client, text: req.body.text });
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ message: "Send failed" }); }
};

exports.sendStudentTaskMessage = async (req, res) => {
  try {
    const msg = await Message.create({ task: req.params.taskId, sender: req.user.id, receiver: req.body.studentId, student: req.body.studentId, text: req.body.text });
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ message: "Send failed" }); }
};

// --- 5. TASK & USER ACTIONS ---
exports.toggleSubmissionVisibility = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { clientCanViewSubmission: req.body.canView }, { new: true });
    res.json({ canView: task.clientCanViewSubmission });
  } catch (error) { return sendServerError(res, error, "Update failed"); }
};

exports.confirmClientPayment = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { adminReceivedPayment: true }, { new: true });
    res.json({ message: "Verified", task });
  } catch (error) { return sendServerError(res, error, "Update failed"); }
};

exports.confirmStudentPayout = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { adminPaidStudent: true }, { new: true });
    res.json({ message: "Verified", task });
  } catch (error) { return sendServerError(res, error, "Update failed"); }
};

exports.updateUserApproval = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { isApproved: req.body.isApproved }, { new: true });
    res.json({ message: "Updated", user });
  } catch (error) { return sendServerError(res, error, "Update failed"); }
};

// --- 6. DATA RETRIEVAL ---
exports.getAllTasks = async (req, res) => {
  try {
    const tasks = await Task.find({}).populate("client student").sort({ createdAt: -1 });
    res.json(tasks);
  } catch (error) { return sendServerError(res, error, "Load failed"); }
};

exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId).populate("client student");
    res.json(task);
  } catch (error) { return sendServerError(res, error, "Load failed"); }
};

exports.getStudentDetails = async (req, res) => {
  try {
    const student = await User.findById(req.params.studentId).select("-password").lean();
    const history = await Task.find({ student: req.params.studentId }).sort({ createdAt: -1 });
    res.json({ student, history });
  } catch (error) { return sendServerError(res, error, "Details failed"); }
};