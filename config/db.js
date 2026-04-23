//backend/config/db.js
const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      throw new Error('MONGO_URI is not set in environment variables');
    }

    // Optional: log which DB/cluster you are connecting to (without credentials)
    try {
      const safeUri = uri.replace(/:\/\/([^:]+):([^@]+)@/, '://<user>:<password>@');
      console.log('Connecting to MongoDB at', safeUri);
    } catch (_) {
      console.log('Connecting to MongoDB...');
    }

    await mongoose.connect(uri);
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
