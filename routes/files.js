// backend/routes/files.js
const express = require('express');
const router = express.Router();
const verifyJWT = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');
const fileController = require('../controllers/fileController');

/**
 * POST /api/files/upload
 * PROTECTED: Requires JWT.
 * Uploads a file to the private vault.
 */
router.post('/upload', verifyJWT, upload.single('file'), fileController.handleUploadResponse);

/**
 * GET /api/files/view/:filename
 * PROTECTED: Requires JWT + Permission Check.
 * Streams the file content securely.
 */
router.get('/view/:filename', verifyJWT, fileController.streamFile);

module.exports = router;