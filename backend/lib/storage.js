const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');


// ---------- Where uploaded pictures are kept ----------
// On this computer: in backend/uploads. Online: in a PRIVATE Supabase Storage bucket, because a
// hosting service wipes its own disk on every restart. Turn it on with SUPABASE_URL and
// SUPABASE_SERVICE_KEY in .env (and SUPABASE_BUCKET, default "uploads").
//
// Files still go through this server, so every "who may see this picture" check stays the same.
// Multer always saves the upload on disk first; put() then moves it to the bucket.
//
// Folders: "files" (delivery proof and dispute evidence), "avatars", "verifications" (ID pictures).

function makeStorage({ url, key, bucket = 'uploads', dirs, fetchImpl = (...a) => fetch(...a) }) {
  const remote = !!(url && key);
  const base = (url || '').replace(/\/$/, '') + '/storage/v1/object';
  const headers = extra => ({ Authorization: 'Bearer ' + key, apikey: key, ...extra });
  const objectPath = (folder, name) => encodeURIComponent(folder) + '/' + encodeURIComponent(path.basename(name));

  async function check(res, what) {
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    throw new Error('Storage ' + what + ' failed: ' + res.status + ' ' + text.slice(0, 200));
  }

  return {
    remote,

    // Keep a file that multer saved on disk. Online it is copied to the bucket and the disk copy removed.
    async put(folder, file) {
      if (!remote) return;
      const body = await fs.promises.readFile(file.path);
      await check(await fetchImpl(base + '/' + bucket + '/' + objectPath(folder, file.filename), {
        method: 'POST',
        headers: headers({ 'Content-Type': file.mimetype || 'application/octet-stream', 'x-upsert': 'false' }),
        body,
      }), 'upload');
      await fs.promises.unlink(file.path).catch(() => {});
    },

    // Send one picture to the browser. A missing file answers 404.
    async send(res, folder, name, { contentType, cacheControl }) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', cacheControl);
      if (!remote) {
        return res.sendFile(path.basename(name), { root: dirs[folder] }, err => {
          if (err && !res.headersSent) res.status(404).json({ message: 'File not found.' });
        });
      }
      try {
        const got = await fetchImpl(base + '/authenticated/' + bucket + '/' + objectPath(folder, name), { headers: headers() });
        if (!got.ok || !got.body) return res.status(404).json({ message: 'File not found.' });
        Readable.fromWeb(got.body).pipe(res);
      } catch (err) {
        console.error('Storage download failed:', err.message);
        if (!res.headersSent) res.status(502).json({ message: 'The picture could not be loaded. Please try again.' });
      }
    },

    // Delete one picture. A missing file is fine; any other problem is logged.
    async remove(folder, name) {
      if (!name) return;
      if (!remote) {
        return fs.promises.unlink(path.join(dirs[folder], path.basename(name))).catch(err => {
          if (err.code !== 'ENOENT') console.error('Could not delete file', path.basename(name), err.message);
        });
      }
      try {
        await check(await fetchImpl(base + '/' + bucket, {
          method: 'DELETE',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ prefixes: [folder + '/' + path.basename(name)] }),
        }), 'delete');
      } catch (err) {
        console.error('Could not delete file', path.basename(name), err.message);
      }
    },

    // The files in one folder, with when each was saved (for the ID picture cleanup)
    async list(folder) {
      if (!remote) {
        const dir = dirs[folder];
        const out = [];
        for (const name of await fs.promises.readdir(dir)) {
          const stat = await fs.promises.stat(path.join(dir, name));
          if (stat.isFile()) out.push({ name, savedAt: stat.mtimeMs });
        }
        return out;
      }
      const res = await check(await fetchImpl(base + '/list/' + bucket, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefix: folder, limit: 1000, offset: 0 }),
      }), 'list');
      return (await res.json())
        .filter(f => f.id)   // folders have no id
        .map(f => ({ name: f.name, savedAt: new Date(f.created_at).getTime() }));
    },
  };
}

module.exports = { makeStorage };
