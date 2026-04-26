//backend/server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const connectDB = require('./config/db');

const app = express();

/*
=====================================
CRITICAL: WEBHOOK RAW PARSER
=====================================
Must be defined BEFORE express.json() for Razorpay 
signature verification to work correctly.
*/
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

/*
=====================================
SAFE ROUTE LOADER (RESTORED 100%)
=====================================
*/
function loadRoute(modulePath, label) {
  try {
    const loaded = require(modulePath);

    const candidate =
      loaded &&
      typeof loaded === 'object' &&
      loaded.default &&
      typeof loaded.default === 'function'
        ? loaded.default
        : loaded;

    if (typeof candidate !== 'function') {
      const receivedType = candidate === null ? 'null' : typeof candidate;
      throw new TypeError(
        `Route "${label}" from "${modulePath}" is not a middleware function. Received: ${receivedType}`
      );
    }

    console.log(`Loaded route: ${label}`);
    return candidate;
  } catch (err) {
    console.error(`Failed to load route "${label}" from "${modulePath}":`, err);
    throw err;
  }
}

/*
=====================================
MIDDLEWARE (RESTORED 100%)
=====================================
*/
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(
  express.json({
    limit: '10mb',
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '10mb',
  })
);

/*
=====================================
HEALTH CHECK (RESTORED 100%)
=====================================
*/
app.get('/', (req, res) => {
  res.status(200).send('SkillBid API Running ✅');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    message: 'SkillBid API is healthy',
    environment: process.env.NODE_ENV || 'development',
  });
});

/*
=====================================
ROUTES (RESTORED 100%)
=====================================
*/
const statsRoutes = loadRoute('./routes/stats', 'statsRoutes');
const authRoutes = loadRoute('./routes/auth', 'authRoutes');
const userRoutes = loadRoute('./routes/user', 'userRoutes');
const taskRoutes = loadRoute('./routes/tasks', 'taskRoutes');
const paymentRoutes = loadRoute('./routes/payments', 'paymentRoutes');
const messageRoutes = loadRoute('./routes/messages', 'messageRoutes');
const skillRoutes = loadRoute('./routes/skills', 'skillRoutes');
const adminRoutes = loadRoute('./routes/admin', 'adminRoutes');
const studentsRoutes = loadRoute('./routes/students', 'studentsRoutes');
const notificationsRoutes = loadRoute('./routes/notifications', 'notificationsRoutes');

app.use('/api/notifications', notificationsRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/skills', skillRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/students', studentsRoutes);

/*
=====================================
404 HANDLER (RESTORED 100%)
=====================================
*/
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl,
    method: req.method,
  });
});

/*
=====================================
GLOBAL ERROR HANDLER (RESTORED 100%)
=====================================
*/
app.use((err, req, res, next) => {
  console.error('GLOBAL ERROR HANDLER:', err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Server error',
    error:
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.stack || String(err),
  });
});

/*
=====================================
DATABASE + SERVER (RESTORED 100%)
=====================================
*/
const PORT = Number(process.env.PORT) || 10000;
let server = null;

async function startServer() {
  try {
    await connectDB();

    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });

    server.on('error', (err) => {
      console.error('HTTP server error:', err);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);

  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

startServer();

module.exports = app;