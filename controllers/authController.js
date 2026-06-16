// backend/controllers/authController.js
const User = require("../models/User");
const Task = require("../models/Task");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { sendNotification } = require("../utils/fcm"); // IMPORTED

// JWT TOKEN FUNCTION
function signToken(user) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }

  return jwt.sign(
    {
      id: user._id.toString(),
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

/**
 * Real-time Broadcast Helper
 */
const emitAuthUpdate = (req, event, data) => {
  const io = req.app.get('socketio');
  if (io) {
    io.emit(event, data);
    // Refresh admin dashboard stats (Total Users counter)
    io.emit('admin_stats_update', { timestamp: new Date() });
  }
};

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function sanitizeString(value) {
  return String(value || "").trim();
}

function sanitizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function isValidRole(role) {
  return ["student", "client", "admin"].includes(role);
}

////////////////////////////////////////////////////////////
/// SIGNUP
////////////////////////////////////////////////////////////

exports.signup = async (req, res) => {
  try {
    const {
      name,
      email,
      mobile,
      password,
      role,
      location, // Requirement: Store for both roles

      // student specific
      skills,
      bankAccountHolderName,
      bankAccountNumber,
      ifscCode,

      // client specific
      company,
      domain,
      description,
    } = req.body;

    const cleanName = sanitizeString(name);
    const cleanEmail = normalizeEmail(email);
    const cleanMobile = sanitizeString(mobile);
    const cleanPassword = String(password || "");
    const cleanRole = sanitizeString(role);
    const cleanLocation = sanitizeString(location);

    // Validation
    if (!cleanName || !cleanEmail || !cleanMobile || !cleanLocation) {
      return res.status(400).json({ message: "Name, Email, Mobile, and Location are required" });
    }

    if (!cleanPassword || cleanPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    if (!isValidRole(cleanRole)) {
      return res.status(400).json({ message: "Invalid role selected" });
    }

    const existing = await User.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(400).json({ message: "Email already registered" });
    }

    const hashed = await bcrypt.hash(cleanPassword, 10);

    const userPayload = {
      name: cleanName,
      email: cleanEmail,
      mobile: cleanMobile,
      password: hashed,
      role: cleanRole,
      location: cleanLocation, // Assigned globally

      // student
      skills: sanitizeArray(skills),
      bankAccountHolderName: sanitizeString(bankAccountHolderName),
      bankAccountNumber: sanitizeString(bankAccountNumber),
      ifscCode: sanitizeString(ifscCode),

      // client
      company: sanitizeString(company),
      domain: sanitizeString(domain),
      description: sanitizeString(description),
    };

    const user = await User.create(userPayload);

    // ============================================================
    // DYNAMIC LOGIC: Link Emergency Guest Tasks
    // ============================================================
    if (user.role === 'client') {
      try {
        const tasksToLink = await Task.find({ isGuestTask: true, 'guestInfo.mobile': cleanMobile });
        if (tasksToLink.length > 0) {
          await Task.updateMany(
            { isGuestTask: true, 'guestInfo.mobile': cleanMobile },
            { 
              $set: { client: user._id, isGuestTask: false, company: user.company || '' },
              $unset: { guestInfo: 1 } 
            }
          );
          
          // Signal Admin task registry to refresh the linked tasks
          const io = req.app.get('socketio');
          if (io) {
            tasksToLink.forEach(t => {
              io.to(t._id.toString()).emit('task_update', { taskId: t._id, linkedToAccount: true });
            });
          }
        }
      } catch (linkErr) {
        console.error('Guest Task linking failed:', linkErr.message);
      }
    }

    // ============================================================
    // DYNAMIC REAL-TIME & NOTIFICATIONS
    // ============================================================
    
    // 1. Refresh Admin User Management UI instantly
    emitAuthUpdate(req, 'user_registered', { userId: user._id, role: user.role });

    // 2. Send Push Notification to platform Admin
    const adminUser = await User.findOne({ role: 'admin' });
    if (adminUser) {
        await sendNotification(adminUser._id.toString(), {
            title: "New User Registered",
            body: `${user.name} joined as a ${user.role}.`,
            data: { type: "user_status_update" }
        });
    }

    const safeUser = await User.findById(user._id).select("-password");

    return res.status(201).json({
      message: "Signup success",
      user: safeUser,
    });
  } catch (err) {
    console.error("Signup error:", err.message);
    return res.status(500).json({ message: "Signup error", error: err.message });
  }
};

////////////////////////////////////////////////////////////
/// LOGIN
////////////////////////////////////////////////////////////

exports.login = async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    const cleanPassword = String(req.body.password || "");

    if (!cleanEmail || !cleanPassword) {
      return res.status(400).json({ message: "Email and Password are required" });
    }

    const user = await User.findOne({ email: cleanEmail });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.isApproved) {
      return res.status(403).json({ message: "Account pending admin approval" });
    }

    const match = await bcrypt.compare(cleanPassword, user.password);

    if (!match) {
      return res.status(401).json({ message: "Invalid password" });
    }

    const token = signToken(user);

    // Update last login for Admin vetting purposes
    user.lastLoginAt = new Date();
    await user.save();

    const safeUser = await User.findById(user._id).select("-password");

    return res.json({
      token,
      user: safeUser,
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ message: "Login error", error: err.message });
  }
};