const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  try {
    // Expect header: Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        message: 'No token',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;
    next();
  } catch (error) {
    console.error('authMiddleware error:', error.message);
    res.status(401).json({
      message: 'Invalid token',
    });
  }
};
