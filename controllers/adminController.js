// backend/controllers/adminController.js
const User = require("../models/User");
const Task = require("../models/Task");
const Message = require("../models/Message");
const { sendNotification } = require("../utils/fcm"); // Now handles DB + Sockets + FCM

/**
 * Standardized error handler
 */
const sendServerError = (res, error, fallbackMessage) => {
  console.error(`AdminController Error: ${error.message || fallbackMessage}`);
  return res.status(500).json({
    message: error.message || fallbackMessage,
  });
};

/**
 * Global Real-time Broadcast Helper
 * Signals the frontend to refresh specific UI components instantly.
 */
const emitUpdate = (req, room, event, data) => {
  const io = req.app.get('socketio');
  if (io) {
    // 1. Send to the specific isolated room (Thread room or User private room)
    io.to(room).emit(event, data);
    // 2. Refresh counters on all Admin Dashboards globally
    io.emit('admin_stats_update', { timestamp: new Date() });
  }
};

// =============================================================================
// FUZZY MATCHING HELPERS
// =============================================================================

function getSimilarity(s1, s2) {
  let longer = s1.toLowerCase().trim();
  let shorter = s2.toLowerCase().trim();
  if (s1.length < s2.length) { [longer, shorter] = [shorter, longer]; }
  let longerLength = longer.length;
  if (longerLength === 0) return 1.0;
  return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
  let costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i == 0) costs[j] = j;
      else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) != s2.charAt(j - 1))
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

// =============================================================================
// 1. DASHBOARD ANALYTICS & GROWTH
// =============================================================================

exports.getOverviewStats = async (req, res) => {
  try {
    const [uTotal, uStu, uCli, tTotal, tCom, tOpen, tActive] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "client" }),
      Task.countDocuments({}),
      Task.countDocuments({ status: "completed" }),
      Task.countDocuments({ status: "open" }),
      Task.countDocuments({ status: "assigned" }),
    ]);

    return res.json({
      users: { total: uTotal, students: uStu, clients: uCli },
      tasks: { total: tTotal, completed: tCom, open: tOpen, active: tActive }
    });
  } catch (error) { return sendServerError(res, error, "Failed to load overview stats"); }
};

exports.getGrowthStats = async (req, res) => {
  try {
    const { metric } = req.query;
    const TargetModel = metric === "students" ? User : Task;
    const growth = await TargetModel.aggregate([
      { $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);
    return res.json(growth);
  } catch (error) { return sendServerError(res, error, "Failed to load trend data"); }
};

exports.getTaskStats = async (req, res) => {
  try {
    const stats = await Task.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
    return res.json({ byStatus: stats });
  } catch (error) { return sendServerError(res, error, "Failed to load funnel stats"); }
};

// =============================================================================
// 2. REGISTRY FILTERS & SEARCH
// =============================================================================

exports.getTaskFilters = async (req, res) => {
  try {
    const [locations, domains] = await Promise.all([Task.distinct("location"), Task.distinct("domain")]);
    return res.json({ locations: locations.filter(Boolean).sort(), domains: domains.filter(Boolean).sort() });
  } catch (error) { return sendServerError(res, error, "Failed to load registry filters"); }
};

exports.getAllTasks = async (req, res) => {
    try {
      const { location, domain, status } = req.query;
      const query = {};
      if (location && location !== 'null' && location.trim() !== '') query.location = location;
      if (domain && domain !== 'null' && domain.trim() !== '') query.domain = domain;
      if (status && status !== 'null' && status.trim() !== '') query.status = status;
  
      const tasks = await Task.find(query)
        .populate("client", "name mobile company guestInfo email")
        .populate("student", "name mobile email")
        .sort({ createdAt: -1 });
      return res.json(tasks);
    } catch (error) { return sendServerError(res, error, "Master list failed"); }
  };

// =============================================================================
// 3. CANDIDATE VETTING
// =============================================================================

exports.getSuggestedStudents = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { location, skill } = req.query;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    let students = await User.find({ role: "student", isApproved: true })
      .select("name email mobile location skills tasksCompleted totalScore totalScoreCount bankAccountHolderName bankAccountNumber ifscCode idCardUrl bio")
      .lean();

    if (location && location.trim() !== '') {
      const locRegex = new RegExp(location.trim(), "i");
      students = students.filter(s => locRegex.test(s.location || ''));
    }

    const searchSkill = (skill && skill.trim() !== '') ? skill.trim() : (task.requiredSkills[0] || null);

    if (searchSkill) {
      students = students.filter(s => {
        return (s.skills || []).some(sSkill => getSimilarity(sSkill, searchSkill) >= 0.8);
      });
    }

    students.sort((a, b) => (b.tasksCompleted || 0) - (a.tasksCompleted || 0));
    return res.json(students);
  } catch (error) { return sendServerError(res, error, "Vetting error"); }
};

// =============================================================================
// 4. CHAT HANDLERS (Isolated Thread Support)
// =============================================================================

exports.getClientTaskMessages = async (req, res) => {
  try {
    const { taskId } = req.params;
    await Message.updateMany({ task: taskId, receiver: req.user.id, student: null }, { $set: { isRead: true } });
    const messages = await Message.find({ task: taskId, student: null }).populate('sender', 'name role').sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) { res.status(500).json({ message: "Error" }); }
};

exports.getStudentTaskMessages = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { studentId } = req.query;
    await Message.updateMany({ task: taskId, receiver: req.user.id, student: studentId }, { $set: { isRead: true } });
    const messages = await Message.find({ task: taskId, student: studentId }).populate('sender', 'name role').sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) { res.status(500).json({ message: "Error" }); }
};

exports.sendClientTaskMessage = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId);
    let msg = await Message.create({ 
        task: task._id, sender: req.user.id, receiver: task.client, text: req.body.text, 
        fileUrl: req.body.fileUrl, fileName: req.body.fileName, isRead: false 
    });
    msg = await msg.populate('sender', 'name role');

    emitUpdate(req, `${req.params.taskId}_client`, 'new_message', msg);

    if (task.client) {
        // MODIFICATION: Pass req to ensure DB + Socket notification
        await sendNotification(task.client.toString(), {
            title: "Admin Message", 
            body: req.body.text || "Attachment received", 
            data: { type: "chat_message", taskId: task._id.toString() }
        }, req);
    }
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ message: "Send failed" }); }
};

exports.sendStudentTaskMessage = async (req, res) => {
  try {
    let msg = await Message.create({ 
        task: req.params.taskId, sender: req.user.id, receiver: req.body.studentId, 
        student: req.body.studentId, text: req.body.text, 
        fileUrl: req.body.fileUrl, fileName: req.body.fileName, isRead: false 
    });
    msg = await msg.populate('sender', 'name role');

    emitUpdate(req, `${req.params.taskId}_student_${req.body.studentId}`, 'new_message', msg);
    emitUpdate(req, req.body.studentId.toString(), 'new_message', msg);

    // MODIFICATION: Pass req to notify student instantly on their inbox
    await sendNotification(req.body.studentId, {
        title: "Message from Admin", 
        body: req.body.text || "Attachment received", 
        data: { type: "chat_message", taskId: req.params.taskId.toString(), studentId: req.body.studentId }
    }, req);
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ message: "Send failed" }); }
};

// =============================================================================
// 5. PROJECT ACTIONS & HYBRID PAYMENTS
// =============================================================================

exports.finalizeTaskBudget = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { amount } = req.body;
    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });
    if (task.adminReceivedPayment) return res.status(400).json({ message: "Already Paid" });

    task.budget = Number(amount);
    task.budgetFinalized = true; 
    await task.save();

    emitUpdate(req, `${taskId}_client`, 'task_update', { taskId, budget: task.budget, budgetFinalized: true });
    if (task.student) {
        emitUpdate(req, `${taskId}_student_${task.student}`, 'task_update', { taskId, budget: task.budget, budgetFinalized: true });
    }
    
    res.json({ message: "Budget Finalized", task });
  } catch (error) { res.status(500).json({ message: "Error" }); }
};

exports.rateStudent = async (req, res) => {
    try {
      const { score, feedback } = req.body; 
      const taskId = req.params.id || req.params.taskId;
      const task = await Task.findById(taskId);
      if (!task) return res.status(404).json({ message: 'Not found' });
      task.rating = Number(score);
      task.feedback = feedback || '';
      await task.save();
      const student = await User.findById(task.student);
      const client = await User.findById(req.user.id);
      if (student) {
        student.totalScore = (student.totalScore || 0) + Number(score);
        student.totalScoreCount = (student.totalScoreCount || 0) + 1;
        student.feedbackEntries.push({ taskId: task._id, taskTitle: task.title, clientId: req.user.id, clientName: client?.name || "Client", rating: Number(score), comment: feedback || "Delivered.", domain: task.domain, createdAt: new Date() });
        await student.save();
        emitUpdate(req, student._id.toString(), 'feedback_update', { score: Number(score) });
        
        // MODIFICATION: Pass req to notify student about the review
        await sendNotification(student._id.toString(), { 
            title: "New Rating!", 
            body: `You received ${score} stars for ${task.title}.`, 
            data: { type: "payment_received", taskId: task._id.toString() } 
        }, req);
      }
      return res.json({ message: 'Rated' });
    } catch (err) { return res.status(500).json({ message: 'Error' }); }
  };

exports.toggleSubmissionVisibility = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { clientCanDownload: req.body.canView }, { new: true });
    emitUpdate(req, `${req.params.taskId}_client`, 'task_update', { taskId: req.params.taskId, clientCanDownload: req.body.canView });
    if (req.body.canView && task.client) {
        // MODIFICATION: Pass req
        await sendNotification(task.client.toString(), { 
            title: "Work Ready!", 
            body: `Admin released files for ${task.title}.`, 
            data: { type: "payment_needed", taskId: task._id.toString() } 
        }, req);
    }
    return res.json({ success: true, clientCanDownload: task.clientCanDownload });
  } catch (error) { res.status(500).json({ message: "Error" }); }
};

/**
 * MODIFICATION: VERIFY PAYMENT & AUTO-UNLOCK DOWNLOADS
 */
exports.confirmClientPayment = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(
        req.params.taskId, 
        { adminReceivedPayment: true, clientCanDownload: true }, 
        { new: true }
    );

    emitUpdate(req, `${req.params.taskId}_client`, 'task_update', { 
        taskId: req.params.taskId,
        adminReceivedPayment: true,
        clientCanDownload: true
    });

    emitUpdate(req, 'admin_room', 'task_update', { taskId: req.params.taskId });

    if (task && task.client) {
        // MODIFICATION: Pass req
        await sendNotification(task.client.toString(), { 
            title: "Payment Verified", 
            body: `Admin confirmed payment for "${task.title}". Files unlocked.`, 
            data: { type: "payment_needed", taskId: task._id.toString() } 
        }, req);
    }

    return res.json({ message: "Payment verified and deliverables unlocked.", task });
  } catch (error) { return sendServerError(res, error, "Confirmation failed"); }
};

exports.confirmStudentPayout = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { adminPaidStudent: true }, { new: true });
    if (task.student) {
        emitUpdate(req, task.student.toString(), 'payout_processed', { taskId: task._id });
        emitUpdate(req, `${task._id}_student_${task.student}`, 'task_update', { taskId: task._id });
        
        // MODIFICATION: Pass req
        await sendNotification(task.student.toString(), { 
            title: "Payout Sent!", 
            body: "Your earnings have been transferred.", 
            data: { type: "withdrawal_update", taskId: task._id.toString() } 
        }, req);
    }
    return res.json({ message: "Paid", task });
  } catch (error) { return sendServerError(res, error, "Error"); }
};

// =============================================================================
// 6. USER ACCOUNT ACTIONS
// =============================================================================

exports.updateUserApproval = async (req, res) => {
    try {
      const user = await User.findByIdAndUpdate(req.params.id, { isApproved: req.body.isApproved }, { new: true });
      emitUpdate(req, req.params.id, 'user_status_update', { isApproved: req.body.isApproved });
      
      // MODIFICATION: Pass req
      await sendNotification(user._id.toString(), { 
          title: req.body.isApproved ? "Account Ready!" : "Account Locked", 
          body: "Check app for status.", 
          data: { type: "user_status_update" } 
      }, req);
      return res.json({ message: "Updated", user });
    } catch (error) { return sendServerError(res, error, "Update failed"); }
};

exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const io = req.app.get('socketio');
    if (io) {
      io.to(id.toString()).emit('user_status_update', { isApproved: false, deleted: true });
    }
    await User.findByIdAndDelete(id);
    res.json({ message: "User account removed." });
  } catch (error) { res.status(500).json({ message: "Deletion failed" }); }
};

// =============================================================================
// 7. RETRIEVAL & ASSIGNMENT
// =============================================================================

exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId)
      .populate("client", "name mobile company guestInfo email")
      .populate("student", "name mobile email skills tasksCompleted totalScore totalScoreCount bankAccountHolderName bankAccountNumber ifscCode idCardUrl bio")
      .populate("requestedStudent");
    return res.json(task);
  } catch (error) { return sendServerError(res, error, "Error"); }
};

exports.getStudentDetails = async (req, res) => {
  try {
    const student = await User.findById(req.params.studentId).select("-password").lean();
    if (!student) return res.status(404).json({ message: "Not found" });
    const history = await Task.find({ student: req.params.studentId }).sort({ createdAt: -1 });
    return res.json({ student, history });
  } catch (error) { return sendServerError(res, error, "Error"); }
};

exports.getTopStudents = async (req, res) => {
  try {
    const top = await User.find({ role: "student" }).sort({ tasksCompleted: -1 }).limit(10);
    return res.json(top);
  } catch (error) { return sendServerError(res, error, "Error"); }
};

exports.assignTaskToStudent = async (req, res) => {
    const { studentId } = req.body;
    try {
      const task = await Task.findById(req.params.taskId);
      task.requestedStudent = studentId;
      task.assignmentRequestStatus = 'request_sent';
      await task.save();
      
      emitUpdate(req, 'admin_room', 'task_update', { taskId: task._id });
      
      // MODIFICATION: Pass req
      await sendNotification(studentId, { 
          title: 'Invitation', 
          body: `New work: ${task.title}`, 
          data: { type: 'task_request', taskId: task._id.toString() } 
      }, req);
      res.json({ message: 'Sent', task });
    } catch (err) { res.status(500).json({ message: "Error" }); }
};