const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// JWT TOKEN FUNCTION
function signToken(user) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }

  return jwt.sign(
    {
      id: user._id.toString(),
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
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
      bankName,
      bankAccountNumber,
      ifscCode,

      // client
      company,
      location,
      domain,
      description,
    } = req.body;

    console.log('SIGNUP BODY:', req.body);

    // CHECK EXISTING USER
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({
        message: 'Email already registered',
      });
    }

    // HASH PASSWORD
    const hashed = await bcrypt.hash(password, 10);

    // CREATE USER
    const user = await User.create({
      name,
      email,
      password: hashed,
      role,

      // student
      skills: skills || [],
      bankAccountHolderName: bankAccountHolderName || '',
      bankName: bankName || '',
      bankAccountNumber: bankAccountNumber || '',
      ifscCode: ifscCode || '',

      // client
      company: company || '',
      location: location || '',
      domain: domain || '',
      description: description || '',
    });

    // REMOVE PASSWORD
    const safeUser = await User.findById(user._id).select('-password');

    res.json({
      message: 'Signup success',
      user: safeUser,
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({
      message: 'Signup error',
      error: err.message,
    });
  }
};

////////////////////////////////////////////////////////////
/// LOGIN
////////////////////////////////////////////////////////////

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        message: 'User not found',
      });
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.status(401).json({
        message: 'Invalid password',
      });
    }

    const token = signToken(user);

    const safeUser = await User.findById(user._id).select('-password');

    res.json({
      token,
      user: safeUser,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Login error',
      error: err.message,
    });
  }
};
