// One-time copy of the pictures saved on this computer into the Supabase Storage bucket.
// Run it once after setting SUPABASE_URL and SUPABASE_SERVICE_KEY in .env:
//
//   cd backend
//   node scripts/copy-uploads-to-storage.js
//
// Only pictures the database still uses are copied. The files on this computer are left in place,
// so nothing is lost if something goes wrong. It is safe to run again: a file already in the
// bucket is skipped.
const path = require('path');
const { pool } = require('../lib/core');
const { storage, UPLOAD_DIR, AVATAR_DIR, VERIF_DIR } = require('../lib/uploads');
const fs = require('fs');

(async () => {
  if (!storage.remote) {
    console.log('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in backend/.env first.');
    process.exit(1);
  }
  const used = await pool.query(`
    SELECT 'files' AS folder, file_url AS name FROM delivery_proofs
    UNION ALL SELECT 'files', file_url FROM evidence
    UNION ALL SELECT 'avatars', avatar_file FROM users WHERE avatar_file IS NOT NULL
    UNION ALL SELECT 'verifications', id_file FROM verifications WHERE status = 'pending' AND id_file IS NOT NULL
    UNION ALL SELECT 'verifications', selfie_file FROM verifications WHERE status = 'pending' AND selfie_file IS NOT NULL`);
  const dirs = { files: UPLOAD_DIR, avatars: AVATAR_DIR, verifications: VERIF_DIR };
  const mime = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

  let copied = 0, skipped = 0, missing = 0, failed = 0;
  for (const { folder, name } of used.rows) {
    const file = path.basename(name);
    const local = path.join(dirs[folder], file);
    if (!fs.existsSync(local)) { missing++; continue; }
    const inBucket = (await storage.list(folder)).some(f => f.name === file);
    if (inBucket) { skipped++; continue; }
    // put() removes the disk copy after uploading, so it gets a temporary copy instead
    const temp = local + '.copy';
    fs.copyFileSync(local, temp);
    try {
      await storage.put(folder, { path: temp, filename: file, mimetype: mime[path.extname(file).toLowerCase()] });
      copied++;
    } catch (err) {
      fs.rmSync(temp, { force: true });
      console.error('Could not copy', folder + '/' + file + ':', err.message);
      failed++;
    }
  }
  console.log(`Copied ${copied}, already in the bucket ${skipped}, missing on this computer ${missing}, failed ${failed}.`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err.message); process.exit(1); });
