const express = require('express');
const cors = require('cors');
require('dotenv').config();

const connectDB = require('./config/db');

const app = express();

/*
=====================================
SAFE ROUTE LOADER
=====================================
*/
function loadRoute(modulePath, label) {
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

  return candidate;
}

/*
=====================================
MIDDLEWARE
=====================================
*/
app.use(cors());

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
HEALTH CHECK
=====================================
*/
app.get('/', (req, res) => {
  res.status(200).send('SkillBid API Running ✅');
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
const bidRoutes = loadRoute('./routes/bids', 'bidRoutes');
const paymentRoutes = loadRoute('./routes/payments', 'paymentRoutes');
const messageRoutes = loadRoute('./routes/messages', 'messageRoutes');
const skillRoutes = loadRoute('./routes/skills', 'skillRoutes');
const taskRequestRoutes = loadRoute('./routes/taskrequests', 'taskRequestRoutes');
const adminRoutes = loadRoute('./routes/admin', 'adminRoutes');

app.use('/api/stats', statsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/bids', bidRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/skills', skillRoutes);
app.use('/api/task-requests', taskRequestRoutes);
app.use('/api/admin', adminRoutes);

/*
=====================================
404 HANDLER
=====================================
*/
app.use((req, res) => {
  res.status(404).json({
    message: 'Route not found',
    path: req.originalUrl,
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

async function startServer() {
  try {
    await connectDB();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();