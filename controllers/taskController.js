const Task = require('../models/Task');
const User = require('../models/User');

// req.body is expected to contain:
// title, description, budget, deadline, location, domain, requiredSkills, company,
// attachments (array of URLs), attachmentNames (array of strings), etc.
exports.createTask = async (req, res) => {
  if (req.user.role !== 'client') {
    return res.status(403).json({ message: 'Forbidden' });
  }

  try {
    console.log('createTask body.attachments:', req.body.attachments);
    console.log('createTask body.attachmentNames:', req.body.attachmentNames);

    const task = await Task.create({
      ...req.body,
      client: req.user.id, // ensure owner is set from auth
    });

    // attachments & attachmentNames are part of req.body and will be saved
    // as long as Task schema has those fields.

    res.json(task);
  } catch (err) {
    console.error('Error creating task:', err);
    res
      .status(400)
      .json({ message: 'Error creating task', error: err.message });
  }
};

exports.getAllTasks = async (req, res) => {
  try {
    const tasks = await Task.find({ status: 'open' }).populate(
      'client',
      'name email'
    );
    // This will include attachments & attachmentNames automatically
    // if they exist on the Task schema.
    res.json(tasks);
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res
      .status(500)
      .json({ message: 'Error fetching tasks', error: err.message });
  }
};

// OPTIONAL: use this to debug a single task from Postman
exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId).populate(
      'client',
      'name email'
    );
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    res.json(task);
  } catch (err) {
    console.error('Error fetching task by id:', err);
    res
      .status(500)
      .json({ message: 'Error fetching task by id', error: err.message });
  }
};

exports.submitWork = async (req, res) => {
  const { fileUrl } = req.body;

  try {
    const task = await Task.findById(req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.status !== 'assigned') {
      return res.status(400).json({ message: 'Task not assigned' });
    }

    task.submission = {
      fileUrl,
      student: req.user.id,
      approved: false,
    };
    await task.save();

    res.json(task);
  } catch (err) {
    console.error('Error submitting work:', err);
    res
      .status(500)
      .json({ message: 'Error submitting work', error: err.message });
  }
};

exports.approveWork = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (req.user.id !== task.client.toString()) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (!task.submission) {
      return res.status(400).json({ message: 'No submission to approve' });
    }

    task.submission.approved = true;
    task.status = 'completed';
    await task.save();

    const student = await User.findById(task.submission.student);
    if (student) {
      student.wallet += task.budget;
      await student.save();
    }

    res.json({ task, studentWallet: student ? student.wallet : null });
  } catch (err) {
    console.error('Error approving work:', err);
    res
      .status(500)
      .json({ message: 'Error approving work', error: err.message });
  }
};

exports.rateStudent = async (req, res) => {
  const { rating } = req.body;

  try {
    const task = await Task.findById(req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    task.rating = rating;
    await task.save();
    res.json(task);
  } catch (err) {
    console.error('Error rating student:', err);
    res
      .status(500)
      .json({ message: 'Error rating student', error: err.message });
  }
};
