const jwt = require('jsonwebtoken');
require('dotenv').config();

const verifyJWT = (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';

  // Debug: log incoming header (do not log full token in production)
  console.log('[AUTH] Incoming Authorization header:', authHeader);

  // Expected format: "Bearer <token>"
  if (!authHeader.startsWith('Bearer ')) {
    console.warn('[AUTH] No Bearer token provided');
    return res.status(401).json({ message: 'No token provided' });
  }

  const token = authHeader.split(' ')[1]; // extract the real token

  if (!process.env.JWT_SECRET) {
    console.error('[AUTH] JWT_SECRET is not defined in environment');
    return res
      .status(500)
      .json({ message: 'Server misconfigured: JWT secret missing' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      console.error('[AUTH] JWT verify error:', err.name, err.message);
      return res.status(401).json({ message: 'Invalid token' });
    }

    // Debug: successful decode
    console.log('[AUTH] JWT verified OK:', {
      id: decoded.id,
      role: decoded.role,
    });

    req.user = decoded;
    next();
  });
};

module.exports = verifyJWT;
