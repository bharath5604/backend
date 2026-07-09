// backend/server.js
const express = require('express');
const cors = require('cors');
const http = require('http'); // Required for Socket.io
const { Server } = require('socket.io'); // Required for Real-time
require('dotenv').config();

const connectDB = require('./config/db');

const app = express();
const server = http.createServer(app); // Wrap express app with HTTP server

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: "https://api.skilern.com", // Adjust this to your production domain in live mode
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Make socket.io accessible in all route files via req.app.get('socketio')
app.set('socketio', io);

/*
=====================================
REAL-TIME CONNECTION LOGIC
=====================================
*/
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Users join a specific task room to see chat updates instantly
  socket.on('join_task', (taskId) => {
    socket.join(taskId);
    console.log(`User joined task room: ${taskId}`);
  });

  // Users join a personal room to receive wallet/status/chat updates
  socket.on('join_user', (userId) => {
    socket.join(userId);
    console.log(`User joined private room: ${userId}`);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

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
SAFE ROUTE LOADER
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
MIDDLEWARE
=====================================
*/
app.use(
  cors({
    origin: "https://api.skilern.com", // Set this to your production domain when deploying to VPS
    credentials: true,
  })
);

app.use(
  express.json({
    limit: '15mb', // Increased limit for larger JSON payloads if needed
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '15mb',
  })
);

/*
=====================================
HEALTH CHECK
=====================================
*/
app.get('/', (req, res) => {
  res.status(200).send('Skilern API Secure Node Running ✅');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    message: 'Skilern API is healthy',
    environment: process.env.NODE_ENV || 'development',
    sockets: 'active',
    storage: 'Local VPS Vault'
  });
});

/*
=====================================
ROUTES
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

// NEW MODIFICATION: SECURE VPS FILE SYSTEM
const fileRoutes = loadRoute('./routes/files', 'fileRoutes');

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

// Register the Protected File Route
app.use('/api/files', fileRoutes);

/*
=====================================
404 HANDLER
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
GLOBAL ERROR HANDLER
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
DATABASE + SERVER
=====================================
*/
const PORT = Number(process.env.PORT) || 10000;
let activeServer = null;

async function startServer() {
  try {
    await connectDB();

    activeServer = server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT} (Secure Storage Enabled)`);
    });

    activeServer.on('error', (err) => {
      console.error('HTTP server error:', err);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);

  if (activeServer) {
    activeServer.close(() => {
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