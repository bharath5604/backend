const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ message: 'Authorization header missing' });
    }

    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ message: 'Invalid authorization format' });
    }

    if (!process.env.JWT_SECRET) {
      console.error('authMiddleware error: JWT_SECRET is not set');
      return res.status(500).json({ message: 'Server configuration error' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    return next();
  } catch (error) {
    console.error('authMiddleware error:', error.message);
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};