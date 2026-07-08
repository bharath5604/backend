// backend/middleware/upload.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Logic: Store files in a 'storage/vault' directory. 
// This folder is NOT served via express.static, making it invisible to the web.
const vaultPath = path.join(__dirname, '../../storage/vault');

// Automatically create the directory structure if it doesn't exist
if (!fs.existsSync(vaultPath)) {
    fs.mkdirSync(vaultPath, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, vaultPath);
    },
    filename: (req, file, cb) => {
        // Security: Rename file to timestamp + random string to prevent filename guessing
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        // Keep original extension (e.g. .pdf, .png)
        cb(null, 'vault-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    // Optional: Add logic here to restrict file types (e.g., only allow images/pdfs)
    cb(null, true);
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { 
        fileSize: 20 * 1024 * 1024 // Increased limit to 20MB for deliverables
    } 
});

module.exports = upload;