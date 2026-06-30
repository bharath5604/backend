// backend/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('../models/User'); // MODIFICATION: Imported User model

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // 1. Check for presence of Authorization header
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Authorization header missing',
      });
    }

    const [scheme, token] = authHeader.split(' ');

    // 2. Validate Bearer format
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authorization format. Use: Bearer <token>',
      });
    }

    // 3. Ensure JWT Secret is configured on server
    if (!process.env.JWT_SECRET) {
      console.error('authMiddleware error: JWT_SECRET is not set');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error',
      });
    }

    // 4. Verify and Decode Token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ============================================================
    // MODIFICATION: DATABASE VALIDATION (REAL-TIME SECURITY)
    // ============================================================
    
    // Query the database to ensure this user hasn't been deleted or banned
    // We only select the ID and Approval status to keep the query fast
    const user = await User.findById(decoded.id).select('_id isApproved');

    if (!user) {
      // SCENARIO: User was deleted from the database
      return res.status(401).json({
        success: false,
        message: 'Account no longer exists. Please sign up again.',
        code: 'USER_DELETED'
      });
    }

    if (!user.isApproved) {
      // SCENARIO: Admin has deactivated/banned this account
      return res.status(403).json({
        success: false,
        message: 'Your account is currently suspended. Please contact support.',
        code: 'USER_BANNED'
      });
    }

    // Attach decoded token data to request object
    req.user = decoded;

    return next();
  } catch (error) {
    console.error('authMiddleware error:', error.message);

    // Specific JWT error handling
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Your session has expired. Please login again.',
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid security token.',
      });
    }

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  }
};