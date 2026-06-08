const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

// Use S3 if credentials are set, otherwise store locally
const useS3 = !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY);

let storage;

if (useS3) {
  const { S3Client } = require('@aws-sdk/client-s3');
  const multerS3     = require('multer-s3');
  const s3 = new S3Client({
    region:      process.env.S3_REGION || 'us-east-1',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
  });
  storage = multerS3({
    s3,
    bucket: process.env.S3_BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      cb(null, `permits/${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`);
    },
  });
} else {
  // Local disk storage
  const uploadDir = path.join(__dirname, '../../uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`);
    },
  });
}

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`File type not allowed: ${ext}. Use PDF, JPG, or PNG.`));
  },
});

module.exports = { upload, useS3 };
