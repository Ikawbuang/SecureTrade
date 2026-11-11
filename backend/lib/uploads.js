const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { HttpError, sendError } = require('./core');
const ROOT = path.join(__dirname, '..');


// ---------- Disputes ----------
const UPLOAD_DIR = path.join(ROOT, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });


const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

const MAX_FILES = 5;

const MAX_FILE_MB = 5;


// Make a multer setup that saves images with a random name
function imageUploader({ dir, types, maxMb, maxFiles, wrongTypeMessage }) {
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + types[file.mimetype]),
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: maxFiles },
    fileFilter: (req, file, cb) => {
      if (types[file.mimetype]) return cb(null, true);
      cb(new HttpError(400, wrongTypeMessage));
    },
  });
}


// Run a multer step and turn upload problems into clear messages
function readUpload(multerStep, { tooBigMessage, tooManyMessage, failStatus, failMessage }) {
  return (req, res, next) => multerStep(req, res, err => {
    if (!err) return next();
    if (err instanceof HttpError) return sendError(res, err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: tooBigMessage });
    if (tooManyMessage && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')) {
      return res.status(400).json({ message: tooManyMessage });
    }
    console.error(err);
    res.status(failStatus).json({ message: failMessage });
  });
}


// Send a private picture from one of the upload folders
function sendPrivateImage(res, file, root, cacheControl) {
  res.setHeader('Content-Type', MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cacheControl);
  res.sendFile(file, { root }, err => {
    if (err && !res.headersSent) res.status(404).json({ message: 'File not found.' });
  });
}


// The dispute screenshots (field name "files")
const uploadFiles = readUpload(
  imageUploader({
    dir: UPLOAD_DIR,
    types: IMAGE_TYPES,
    maxMb: MAX_FILE_MB,
    maxFiles: MAX_FILES,
    wrongTypeMessage: 'Only image files (JPG, PNG, WEBP, or GIF) are allowed.',
  }).array('files', MAX_FILES),
  {
    tooBigMessage: 'Each image must be ' + MAX_FILE_MB + ' MB or smaller.',
    tooManyMessage: 'You can upload up to ' + MAX_FILES + ' images.',
    failStatus: 500,
    failMessage: 'Could not read the upload.',
  }
);


async function removeFiles(files) {
  await Promise.all((files || []).map(f => fs.promises.unlink(f.path).catch(() => {})));
}


// ---------- My profile: photo, username, email ----------
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');

fs.mkdirSync(AVATAR_DIR, { recursive: true });

const AVATAR_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const AVATAR_MAX_MB = 2;


// The profile photo (field name "photo")
const uploadAvatar = readUpload(
  imageUploader({
    dir: AVATAR_DIR,
    types: AVATAR_TYPES,
    maxMb: AVATAR_MAX_MB,
    maxFiles: 1,
    wrongTypeMessage: 'Choose a JPG, PNG, or WEBP photo.',
  }).single('photo'),
  { tooBigMessage: 'The photo must be ' + AVATAR_MAX_MB + ' MB or smaller.', failStatus: 400, failMessage: 'Could not read the photo.' }
);


// Make sure the file really is the kind of image it says it is
async function looksLikeImage(filePath, ext) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    await handle.read(buf, 0, 12, 0);
    if (ext === '.jpg') return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    if (ext === '.png') return buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
    if (ext === '.webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    if (ext === '.gif') return ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6));
    return false;
  } finally {
    await handle.close();
  }
}


// Every uploaded file must really be the kind of image it says it is
async function assertRealImages(files, message) {
  for (const file of files) {
    if (!(await looksLikeImage(file.path, path.extname(file.filename)))) throw new HttpError(400, message);
  }
}


// Delete one saved file by name (a missing file is fine)
function removeSavedFile(dir, name) {
  if (!name) return Promise.resolve();
  return fs.promises.unlink(path.join(dir, path.basename(name))).catch(() => {});
}


const removeAvatarFile = name => removeSavedFile(AVATAR_DIR, name);

const removeVerifFile = name => removeSavedFile(VERIF_DIR, name);


// ---------- Identity verification ----------
// The user shows an ID and a selfie holding the ID next to a code. An admin reviews it.
// The admin also checks that the ID shows the person is 18 or older.
// The pictures are private and are deleted as soon as the admin decides. No ID number is saved.
const VERIF_DIR = path.join(UPLOAD_DIR, 'verifications');

fs.mkdirSync(VERIF_DIR, { recursive: true });

const VERIF_MAX_MB = 5;


// The ID picture and the selfie
const uploadVerification = readUpload(
  imageUploader({
    dir: VERIF_DIR,
    types: AVATAR_TYPES,
    maxMb: VERIF_MAX_MB,
    maxFiles: 2,
    wrongTypeMessage: 'The pictures must be JPG, PNG, or WEBP.',
  }).fields([{ name: 'id_photo', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]),
  { tooBigMessage: 'Each picture must be ' + VERIF_MAX_MB + ' MB or smaller.', failStatus: 400, failMessage: 'Could not read the pictures.' }
);
module.exports = { UPLOAD_DIR, IMAGE_TYPES, MIME_BY_EXT, MAX_FILES, MAX_FILE_MB, imageUploader, readUpload, sendPrivateImage, uploadFiles, removeFiles, AVATAR_DIR, AVATAR_TYPES, AVATAR_MAX_MB, uploadAvatar, looksLikeImage, assertRealImages, removeSavedFile, removeAvatarFile, removeVerifFile, VERIF_DIR, VERIF_MAX_MB, uploadVerification };
