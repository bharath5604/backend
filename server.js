const express = require('express');
const connectDB = require('./config/db');
const cors = require('cors');
require('dotenv').config();

// Routers
const studentRoutes = require('./routes/students');
const notificationRoutes = require('./routes/notifications');
const statsRoutes = require('./routes/stats');
const bidRoutes = require('./routes/bids');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Core routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/tasks', require('./routes/tasks'));      // includes /recommended, /mine, /assigned
app.use('/api/bids', bidRoutes);
app.use('/api/admin', require('./routes/admin'));
app.use('/api/users', require('./routes/user'));

// Domain routes
app.use('/api/students', require('./routes/students'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/payments', require('./routes/payments'));

// Extra / legacy mounts (keep only if still used)
app.use('/api', studentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/stats', statsRoutes);

// DB + server start
connectDB();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
