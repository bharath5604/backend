// backend/controllers/adminController.js
const User = require("../models/User");
const Task = require("../models/Task");
const Message = require("../models/Message");

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
// 3. CANDIDATE VETTING (Filter Candidates)
// =============================================================================

exports.getSuggestedStudents = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { location, skill } = req.query;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    let query = { role: "student", isApproved: true };

    if (skill && skill !== 'null' && skill.trim() !== '') {
      query.skills = { $in: [new RegExp(skill.trim(), "i")] };
    } else if (task.requiredSkills && task.requiredSkills.length > 0) {
      query.skills = { $in: task.requiredSkills };
    }

    if (location && location !== 'null' && location.trim() !== '') {
      query.location = new RegExp(location.trim(), "i");
    }

    const candidates = await User.find(query)
      .select("name email mobile location skills tasksCompleted totalScore totalScoreCount")
      .sort({ tasksCompleted: -1 })
      .lean();

    return res.json(candidates);
  } catch (error) {
    return sendServerError(res, error, "Error identifying candidates");
  }
};

// =============================================================================
// 4. CHAT HANDLERS
// =============================================================================

exports.getClientTaskMessages = async (req, res) => {
  try {
    const messages = await Message.find({ task: req.params.taskId, student: null })
    .populate('sender', 'name role')
    .sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) { res.status(500).json({ message: "Error loading client chat" }); }
};

exports.getStudentTaskMessages = async (req, res) => {
  try {
    const messages = await Message.find({ task: req.params.taskId, student: req.query.studentId })
    .populate('sender', 'name role')
    .sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) { res.status(500).json({ message: "Error loading student chat" }); }
};

exports.sendClientTaskMessage = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId);
    const msg = await Message.create({ task: task._id, sender: req.user.id, receiver: task.client, text: req.body.text });
    
    // DYNAMIC EMIT: Let the client see the new message instantly
    emitUpdate(req, req.params.taskId, 'new_message', msg);
    
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ message: "Send failed" }); }
};

exports.sendStudentTaskMessage = async (req, res) => {
  try {
    const msg = await Message.create({ task: req.params.taskId, sender: req.user.id, receiver: req.body.studentId, student: req.body.studentId, text: req.body.text });
    
    // DYNAMIC EMIT: Let the specific student see the new message instantly
    emitUpdate(req, req.params.taskId, 'new_message', msg);
    
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
      if (isNaN(scoreNum)) return res.status(400).json({ message: "Invalid score" });
  
      task.rating = scoreNum;
      task.feedback = feedback || '';
      task.score = scoreNum;
      await task.save();
  
      const student = await User.findById(task.student);
      const client = await User.findById(req.user.id);
  
      if (student) {
        if (!student.feedbackEntries) student.feedbackEntries = [];
        if (!student.feedbackScores) student.feedbackScores = [];
  
        student.totalScore = (student.totalScore || 0) + scoreNum;
        student.totalScoreCount = (student.totalScoreCount || 0) + 1;
  
        const taskDomain = task.domain || 'General';
        let domainIndex = student.feedbackScores.findIndex(s => s.domain === taskDomain);
        if (domainIndex > -1) {
          student.feedbackScores[domainIndex].totalScore += scoreNum;
          student.feedbackScores[domainIndex].count += 1;
        } else {
          student.feedbackScores.push({ domain: taskDomain, totalScore: scoreNum, count: 1 });
        }
  
        student.feedbackEntries.push({
          taskId: task._id,
          taskTitle: task.title,
          clientId: req.user.id,
          clientName: client?.name || "Client",
          rating: scoreNum,
          comment: feedback || "Delivered successfully.",
          domain: taskDomain,
          createdAt: new Date()
        });
  
        await student.save();

        // DYNAMIC EMIT: Update the student's reputation dashboard instantly
        emitUpdate(req, student._id.toString(), 'feedback_update', { score: scoreNum });
      }
      return res.json({ message: 'Reputation updated' });
    } catch (err) {
      return res.status(500).json({ message: 'Rating failed', error: err.message });
    }
  };

// =============================================================================
// 6. TASK ACTIONS & VISIBILITY
// =============================================================================

exports.toggleSubmissionVisibility = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { canView } = req.body;

    const task = await Task.findByIdAndUpdate(
      taskId,
      { clientCanDownload: canView },
      { new: true }
    );

    if (!task) return res.status(404).json({ message: "Task not found" });

    // DYNAMIC EMIT: Unlock the download button on the Client's app instantly
    emitUpdate(req, taskId, 'task_update', { taskId: taskId, clientCanDownload: canView });

    return res.json({ 
        success: true, 
        clientCanDownload: task.clientCanDownload 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.confirmClientPayment = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { adminReceivedPayment: true }, { new: true });
    
    // DYNAMIC EMIT: Update Client's task list to show "Verified" status
    emitUpdate(req, req.params.taskId, 'task_update', { taskId: req.params.taskId });
    
    return res.json({ message: "Verified", task });
  } catch (error) { return sendServerError(res, error, "Confirmation failed"); }
};

exports.confirmStudentPayout = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.taskId, { adminPaidStudent: true }, { new: true });
    
    // DYNAMIC EMIT: Tell the student their payout is done (updates wallet/dashboard)
    if (task.student) {
        emitUpdate(req, task.student.toString(), 'payout_processed', { taskId: task._id });
        emitUpdate(req, task._id.toString(), 'task_update', { taskId: task._id });
    }

    return res.json({ message: "Payout confirmed", task });
  } catch (error) { return sendServerError(res, error, "Payout confirmation failed"); }
};

// =============================================================================
// 7. GENERAL RETRIEVAL
// =============================================================================

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
      
      // DYNAMIC EMIT: If banned, this can be used to force logout the user immediately
      emitUpdate(req, req.params.id, 'user_status_update', { isApproved: req.body.isApproved });

      return res.json({ message: "User status updated", user });
    } catch (error) { return sendServerError(res, error, "Update failed"); }
};

exports.getTopStudents = async (req, res) => {
  try {
    const top = await User.find({ role: "student" }).sort({ tasksCompleted: -1 }).limit(10);
    return res.json(top);
  } catch (error) { return sendServerError(res, error, "Load failed"); }
};