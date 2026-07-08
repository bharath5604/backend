// backend/controllers/fileController.js
const path = require('path');
const fs = require('fs');
const Task = require('../models/Task');
const User = require('../models/User');

/**
 * Validates if the current user has the right to access a specific file.
 * Logic: 
 * 1. Admin has access to everything.
 * 2. If it's a Student ID, only that Student and Admin can see it.
 * 3. If it's a Task file, only the assigned Student and the Client can see it.
 */
const checkFileAuthorization = async (user, filename) => {
    if (user.role === 'admin') return true;

    // A. Check if the file is a Student ID card
    const userWithId = await User.findOne({ _id: user.id, idCardUrl: { $regex: filename } });
    if (userWithId) return true;

    // B. Check if the file belongs to a Task (Attachment or Submission)
    const task = await Task.findOne({
        $and: [
            { $or: [{ student: user.id }, { client: user.id }] },
            { $or: [
                { "submission.fileUrl": { $regex: filename } },
                { "attachments": { $regex: filename } }
            ]}
        ]
    });

    return !!task;
};

exports.handleUploadResponse = (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No file received' });
    }

    // Logic: We return only the filename. 
    // The frontend will construct the protected URL using /api/files/view/:filename
    res.json({
        success: true,
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype
    });
};

exports.streamFile = async (req, res) => {
    try {
        const { filename } = req.params;
        const user = req.user; // Injected by verifyJWT

        // 1. SECURITY CHECK: Verify Ownership/Role
        const isAuthorized = await checkFileAuthorization(user, filename);
        if (!isAuthorized) {
            return res.status(403).json({ message: "Access Denied: You are not authorized to view this file." });
        }

        const filePath = path.join(__dirname, '../../storage/vault', filename);

        // 2. EXISTENCE CHECK
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ message: "File not found on server." });
        }

        // 3. STREAMING LOGIC
        // Using ReadStream is better for performance (especially for videos/large PDFs)
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;

        // Support for Video Streaming (Partial Content)
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'application/octet-stream',
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'application/octet-stream', // Browser/Flutter will handle based on extension
            };
            res.writeHead(200, head);
            fs.createReadStream(filePath).pipe(res);
        }
    } catch (error) {
        console.error("File Streaming Error:", error);
        res.status(500).json({ message: "Internal server error during file retrieval." });
    }
};