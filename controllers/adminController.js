// backend/controllers/adminController.js
const User = require("../models/User");
const Task = require("../models/Task");
const Message = require("../models/Message");
const { sendNotification } = require("../utils/fcm");

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
 * Used to signal the frontend to refresh specific data
 */
const emitUpdate = (req, room, event, data) => {
  const io = req.app.get('socketio');
  if (io) {
    io.to(room).emit(event, data);
    // Also signal the admin dashboard to refresh counters
    io.emit('admin_stats_update', { timestamp: new Date() });
  }
};

// =============================================================================
// FUZZY MATCHING HELPERS (Handles typos like "edting" vs "editing")
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
  } catch (error) {
    return sendServerError(res, error, "Failed to load overview stats");
  }
};

exports.getGrowthStats = async (req, res) => {
  try {
    const { metric } = req.query;
    const TargetModel = metric === "students" ? User : Task;

    const growth = await TargetModel.aggregate([
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    return res.json(growth);
  } catch (error) {
    return sendServerError(res, error, "Failed to load trend data");
  }
};

exports.getTaskStats = async (req, res) => {
  try {
    const stats = await Task.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    return res.json({ byStatus: stats });
  } catch (error) {
    return sendServerError(res, error, "Failed to load funnel stats");
  }
};

// =============================================================================
// 2. REGISTRY FILTERS & SEARCH
// =============================================================================

exports.getTaskFilters = async (req, res) => {
  try {
    const [locations, domains] = await Promise.all([
      Task.distinct("location"),
      Task.distinct("domain"),
    ]);

    return res.json({
      locations: locations.filter(Boolean).sort(),
      domains: domains.filter(Boolean).sort(),
      companies: [],
    });
  } catch (error) {
    return sendServerError(res, error, "Failed to load registry filters");
  }
};

exports.getAllTasks = async (req, res) => {
    try {
      const { location, domain, status } = req.query;
      const query = {};
  
      if (location && location !== 'null' && location.trim() !== '') {
        query.location = location;
      }
      if (domain && domain !== 'null' && domain.trim() !== '') {
        query.domain = domain;
      }
      if (status && status !== 'null' && status.trim() !== '') {
        query.status = status;
      }
  
      const tasks = await Task.find(query)
        .populate("client", "name mobile company guestInfo email")
        .populate("student", "name mobile email")
        .sort({ createdAt: -1 });
  
      return res.json(tasks);
    } catch (error) {
      return sendServerError(res, error, "Master task list load failed");
    }
  };

// =============================================================================
// 3. CANDIDATE VETTING (WITH FUZZY MATCHING)
// =============================================================================

exports.getSuggestedStudents = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { location, skill } = req.query;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    let allStudents = await User.find({ role: "student", isApproved: true })
      .select("name email mobile location skills tasksCompleted totalScore totalScoreCount bankAccountHolderName bankAccountNumber ifscCode")
      .lean();

    // 1. Filter by Location
    if (location && location !== 'null' && location.trim() !== '') {
      const locRegex = new RegExp(location.trim(), "i");
      allStudents = allStudents.filter(s => locRegex.test(s.location || ''));
    }

    // 2. Fuzzy Skill Search
    const searchSkill = (skill && skill !== 'null' && skill.trim() !== '') 
                        ? skill.trim() 
                        : (task.requiredSkills && task.requiredSkills.length > 0 ? task.requiredSkills[0] : null);

    if (searchSkill) {
      allStudents = allStudents.filter(student => {
        return (student.skills || []).some(sSkill => {
            const similarity = getSimilarity(sSkill, searchSkill);
            return similarity >= 0.8; 
        });
      });
    }

    // 3. Sort by experience
    allStudents.sort((a, b) => (b.tasksCompleted || 0) - (a.tasksCompleted || 0));

    return res.json(allStudents);
  } catch (error) {
    return sendServerError(res, error, "Error identifying candidates");
  }
};

// =============================================================================
// 4. CHAT HANDLERS (WITH UNREAD DOT & PUSH LOGIC)
// =============================================================================

exports.getClientTaskMessages = async (req, res) => {
  try {
    const { taskId } = req.params;
    // Mark received messages as READ
    await Message.updateMany({ task: taskId, receiver: req.user.id, student: null }, { $set: { isRead: true } });

    const messages = await Message.find({ task: taskId, student: null })
    .populate('sender', 'name role')
    .sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) { res.status(500).json({ message: "Error loading client chat" }); }
};

exports.getStudentTaskMessages = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { studentId } = req.query;
    // Mark received messages as READ
    await Message.updateMany({ task: taskId, receiver: req.user.id, student: studentId }, { $set: { isRead: true } });

    const messages = await Message.find({ task: taskId, student: studentId })
    .populate('sender', 'name role')
    .sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) { res.status(500).json({ message: "Error loading student chat" }); }
};

exports.sendClientTaskMessage = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId);
    const msg = await Message.create({ task: task._id, sender: req.user.id, receiver: task.client, text: req.body.text, isRead: false });
    
    emitUpdate(req, req.params.taskId, 'new_message', msg);

    if (task.client) {
        await sendNotification(task.client.toString(), {
            title: "Admin Message",
            body: req.body.text,
            data: { type: "chat_message", taskId: task._id.toString() }
        });
    }
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ message: "Send failed" }); }
};

exports.sendStudentTaskMessage = async (req, res) => {
  try {
    const msg = await Message.create({ task: req.params.taskId, sender: req.user.id, receiver: req.body.studentId, student: req.body.studentId, text: req.body.text, isRead: false });
    
    emitUpdate(req, req.params.taskId, 'new_message', msg);

    await sendNotification(req.body.studentId, {
        title: "Message from Admin",
        body: req.body.text,
        data: { type: "chat_message", taskId: req.params.taskId.toString(), studentId: req.body.studentId }
    });
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ message: "Send failed" }); }
};

// =============================================================================
// 5. REPUTATION & RATING
// =============================================================================

exports.rateStudent = async (req, res) => {
    try {
      const { score, feedback } = req.body; 
      const taskId = req.params.id || req.params.taskId;
  
      const task = await Task.findById(taskId);
      if (!task) return res.status(404).json({ message: 'Task not found' });
  
      const scoreNum = Number(score);
      task.rating = scoreNum;
      task.feedback = feedback || '';
      task.score = scoreNum;
      await task.save();
  
      const student = await User.findById(task.student);
      const client = await User.findById(req.user.id);
  
      if (student) {
        student.totalScore = (student.totalScore || 0) + scoreNum;
        student.totalScoreCount = (student.totalScoreCount || 0) + 1;
        
        student.feedbackEntries.push({
          taskId: task._id,
          taskTitle: task.title,
          clientId: req.user.id,
          clientName: client?.name || "Client",
          rating: scoreNum,
          comment: feedback || "Delivered successfully.",
          domain: task.domain || 'General',
          createdAt: new Date()
        });
  
        await student.save();
        emitUpdate(req, student._id.toString(), 'feedback_update', { score: scoreNum });

        await sendNotification(student._id.toString(), {
            title: "New Review Received",
            body: `Client rated your work ${scoreNum} stars.`,
            data: { type: "payment_received" }
        });
      }
      return res.json({ message: 'Reputation updated' });
    } catch (err) {
      return res.status(500).json({ message: 'Rating failed' });
    }
  };

// =============================================================================
// 6. TASK ACTIONS & VISIBILITY
// =============================================================================

exports.toggleSubmissionVisibility = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { canView } = req.body;

    const task = await Task.findByIdAndUpdate(taskId, { clientCanDownload: canView }, { new: true });
    if (!task) return res.status(404).json({ message: "Task not found" });

    emitUpdate(req, taskId, 'task_update', { taskId: taskId, clientCanDownload: canView });

    if (canView && task.client) {
        await sendNotification(task.client.toString(), {
            title: "Work Ready!",
            body: `Admin released the files for "${task.title}".`,
            data: { type: "payment_needed" }
        });
    }

    return res.json({ success: true, clientCanDownload: task.clientCanDownload });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.confirmClientPayment = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { adminReceivedPayment: true }, { new: true });
    emitUpdate(req, req.params.taskId, 'task_update', { taskId: req.params.taskId });
    
    if (task.client) {
        await sendNotification(task.client.toString(), {
            title: "Payment Verified",
            body: `Admin verified your payment for "${task.title}".`,
            data: { type: "payment_needed" }
        });
    }

    return res.json({ message: "Verified", task });
  } catch (error) { return sendServerError(res, error, "Confirmation failed"); }
};

exports.confirmStudentPayout = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { adminPaidStudent: true }, { new: true });
    if (task.student) {
        emitUpdate(req, task.student.toString(), 'payout_processed', { taskId: task._id });
        emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id });

        await sendNotification(task.student.toString(), {
            title: "Payout Sent!",
            body: `Payment for "${task.title}" has been sent to your account.`,
            data: { type: "withdrawal_update" }
        });
    }
    return res.json({ message: "Payout confirmed", task });
  } catch (error) { return sendServerError(res, error, "Payout confirmation failed"); }
};

// =============================================================================
// 7. GENERAL RETRIEVAL
// =============================================================================

exports.assignTaskToStudent = async (req, res) => {
  const { studentId } = req.body;
  try {
    const task = await Task.findById(req.params.taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    task.requestedStudent = studentId;
    task.assignmentRequestStatus = 'request_sent';
    await task.save();

    emitUpdate(req, 'admin_room', 'task_update', { taskId: task._id });

    await sendNotification(studentId, {
      title: 'New Assignment Invitation',
      body: `Admin invited you to discuss: ${task.title}`,
      data: { type: 'task_request', taskId: task._id.toString() }
    });

    res.json({ message: 'Invitation sent', task });
  } catch (err) { res.status(500).json({ message: "Failed to process invitation" }); }
};

exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId).populate("client student requestedStudent");
    return res.json(task);
  } catch (error) { return sendServerError(res, error, "Task load failed"); }
};

exports.getStudentDetails = async (req, res) => {
  try {
    const student = await User.findById(req.params.studentId).select("-password").lean();
    if (!student) return res.status(404).json({ message: "Not found" });
    const history = await Task.find({ student: req.params.studentId }).sort({ createdAt: -1 });
    return res.json({ student, history });
  } catch (error) { return sendServerError(res, error, "Load failed"); }
};

exports.updateUserApproval = async (req, res) => {
    try {
      const user = await User.findByIdAndUpdate(req.params.id, { isApproved: req.body.isApproved }, { new: true });
      emitUpdate(req, req.params.id, 'user_status_update', { isApproved: req.body.isApproved });
      
      await sendNotification(user._id.toString(), {
          title: req.body.isApproved ? "Account Activated!" : "Account Deactivated",
          body: req.body.isApproved ? "Welcome to Skilen!" : "Your account has been suspended.",
          data: { type: "user_status_update" }
      });

      return res.json({ message: "User status updated", user });
    } catch (error) { return sendServerError(res, error, "Update failed"); }
};

exports.getTopStudents = async (req, res) => {
  try {
    const top = await User.find({ role: "student" }).sort({ tasksCompleted: -1 }).limit(10);
    return res.json(top);
  } catch (error) { return sendServerError(res, error, "Load failed"); }
};