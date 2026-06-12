const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

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
      password,
      role,

      // student
      skills,
      bankAccountHolderName,
      bankAccountNumber,
      ifscCode,

      // client
      company,
      location,
      domain,
      description,
    } = req.body;

    const cleanName = sanitizeString(name);
    const cleanEmail = normalizeEmail(email);
    const cleanPassword = String(password || "");
    const cleanRole = sanitizeString(role);

    if (!cleanName) {
      return res.status(400).json({
        message: "Name is required",
      });
    }

    if (!cleanEmail) {
      return res.status(400).json({
        message: "Email is required",
      });
    }

    if (!cleanPassword || cleanPassword.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters",
      });
    }

    if (!isValidRole(cleanRole)) {
      return res.status(400).json({
        message: "Invalid role",
      });
    }

    const existing = await User.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(400).json({
        message: "Email already registered",
      });
    }

    const hashed = await bcrypt.hash(cleanPassword, 10);

    const userPayload = {
      name: cleanName,
      email: cleanEmail,
      password: hashed,
      role: cleanRole,

      // student
      skills: sanitizeArray(skills),
      bankAccountHolderName: sanitizeString(bankAccountHolderName),
      bankAccountNumber: sanitizeString(bankAccountNumber),
      ifscCode: sanitizeString(ifscCode),

      // client
      company: sanitizeString(company),
      location: sanitizeString(location),
      domain: sanitizeString(domain),
      description: sanitizeString(description),
    };

    const user = await User.create(userPayload);

    const safeUser = await User.findById(user._id).select("-password");

    return res.status(201).json({
      message: "Signup success",
      user: safeUser,
    });
  } catch (err) {
    console.error("Signup error:", err.message);

    return res.status(500).json({
      message: "Signup error",
      error: err.message,
    });
  }
};

////////////////////////////////////////////////////////////
/// LOGIN
////////////////////////////////////////////////////////////

exports.login = async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    const cleanPassword = String(req.body.password || "");

    if (!cleanEmail) {
      return res.status(400).json({
        message: "Email is required",
      });
    }

    if (!cleanPassword) {
      return res.status(400).json({
        message: "Password is required",
      });
    }

    const user = await User.findOne({ email: cleanEmail });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const match = await bcrypt.compare(cleanPassword, user.password);

    if (!match) {
      return res.status(401).json({
        message: "Invalid password",
      });
    }

    const token = signToken(user);

    const safeUser = await User.findById(user._id).select("-password");

    return res.json({
      token,
      user: safeUser,
    });
  } catch (err) {
    console.error("Login error:", err.message);

    return res.status(500).json({
      message: "Login error",
      error: err.message,
    });
  }
};