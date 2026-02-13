const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Helper: sign JWT with consistent payload + secret
function signToken(user) {
  if (!process.env.JWT_SECRET) {
    console.error('[AUTH] JWT_SECRET is not defined in environment');
    throw new Error('JWT_SECRET is not configured');
  }

  // Debug: do NOT log the secret, just confirm it's present
  console.log('[AUTH] Signing token for user', {
    id: user._id.toString(),
    role: user.role,
  });

  return jwt.sign(
    { id: user._id.toString(), role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

exports.signup = async (req, res) => {
  const { name, email, password, role } = req.body;
  try {
    console.log('[AUTH] Signup requested', { email, role });

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashed, role });

    // For security, do not send password back
    const safeUser = await User.findById(user._id).select('-password');

    res.json({ message: 'User created', user: safeUser });
  } catch (err) {
    console.error('[AUTH] Error creating user', err.message);
    res
      .status(400)
      .json({ message: 'Error creating user', error: err.message });
  }
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  try {
    console.log('[AUTH] Login requested', { email });

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    let token;
    try {
      token = signToken(user);
    } catch (e) {
      console.error('[AUTH] Error signing token', e.message);
      return res
        .status(500)
        .json({ message: 'Token generation error', error: e.message });
    }

    // Strip password from response
    const safeUser = await User.findById(user._id).select('-password');

    console.log('[AUTH] Login success, user', {
      id: user._id.toString(),
      role: user.role,
    });

    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('[AUTH] Login error', err.message);
    res
      .status(500)
      .json({ message: 'Login error', error: err.message });
  }
};
