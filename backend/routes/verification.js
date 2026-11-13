const path = require('path');
const { auth } = require('../lib/auth');
const { HttpError, ID_TYPES, NAME_PART_RE, VERIFY_CODE_HOURS, cleanName, isAdmin, isDbId, logActivity, pool, queryAll, queryOne, route, sameId, withTx } = require('../lib/core');
const { newSixDigitCode } = require('../lib/mail');
const { VERIF_DIR, assertRealImages, removeFiles, saveUploads, sendPrivateImage, uploadVerification } = require('../lib/uploads');



// Adds these routes to the app
function register(app) {

  // My verification: am I verified, is a request waiting, was one rejected, my current code,
  // and who tried to trade with me while I was not verified
  app.get('/api/verification', auth, route(async (req, res) => {
    const id = req.user.user_id;
    const u = await queryOne(
      pool,
      `SELECT first_name, last_name, full_name, verified_at, role, verify_code, verify_code_expires_at
       FROM users WHERE user_id = $1`,
      [id]
    );
    const latest = await queryOne(
      pool,
      `SELECT status, typed_name, typed_first_name, typed_last_name, id_type, reject_reason, submitted_at, decided_at
       FROM verifications WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
      [id]
    );

    const verified = !!u.verified_at || u.role === 'admin';
    let attempts = [];
    if (!verified) {
      attempts = await queryAll(
        pool,
        `SELECT us.username, ta.created_at
         FROM trade_attempts ta JOIN users us ON us.user_id = ta.from_user_id
         WHERE ta.target_user_id = $1 AND ta.created_at > now() - interval '14 days'
         ORDER BY ta.created_at DESC LIMIT 5`,
        [id]
      );
    }

    const codeActive = u.verify_code && new Date(u.verify_code_expires_at) > new Date();
    res.json({
      verified,
      verified_at: u.verified_at,
      first_name: u.first_name,
      last_name: u.last_name,
      full_name: u.full_name,
      id_types: ID_TYPES,
      pending: latest && latest.status === 'pending' ? latest : null,
      rejected: latest && latest.status === 'rejected' ? latest : null,
      code: codeActive ? u.verify_code : null,
      code_expires_at: codeActive ? u.verify_code_expires_at : null,
      attempts,
    });
  }));


  // A code to write on paper and hold in the selfie (a new one each time, good for 24 hours)
  app.post('/api/verification/code', auth, route(async (req, res) => {
    const id = req.user.user_id;
    const u = await queryOne(pool, 'SELECT verified_at, role FROM users WHERE user_id = $1', [id]);
    if (u.verified_at || u.role === 'admin') throw new HttpError(409, 'You are already verified.');
    const pending = await queryOne(pool, `SELECT 1 FROM verifications WHERE user_id = $1 AND status = 'pending'`, [id]);
    if (pending) throw new HttpError(409, 'Your request is already being reviewed.');

    const code = newSixDigitCode();
    const r = await pool.query(
      `UPDATE users SET verify_code = $1, verify_code_expires_at = now() + interval '${VERIFY_CODE_HOURS} hours'
       WHERE user_id = $2 RETURNING verify_code_expires_at`,
      [code, id]
    );
    res.json({ ok: true, code, code_expires_at: r.rows[0].verify_code_expires_at });
  }));


  // Send the ID, the selfie with the code, and the first and last name exactly as written on the ID
  app.post('/api/verification/submit', auth, uploadVerification, route(async (req, res) => {
    const files = req.files ? Object.values(req.files).flat() : [];
    try {
      const first = cleanName(req.body.first_name);
      const last = cleanName(req.body.last_name);
      const idType = String(req.body.id_type || '');
      if (!NAME_PART_RE.test(first) || !NAME_PART_RE.test(last)) {
        throw new HttpError(400, 'Type your first name and last name exactly as they are written on your ID (letters only).');
      }
      const typed = first + ' ' + last;
      if (!ID_TYPES.includes(idType)) throw new HttpError(400, 'Choose the kind of ID you are showing.');
      if (req.body.consent !== 'true') throw new HttpError(400, 'Please agree to the verification terms.');

      const idPhoto = req.files && req.files.id_photo && req.files.id_photo[0];
      const selfie = req.files && req.files.selfie && req.files.selfie[0];
      if (!idPhoto || !selfie) throw new HttpError(400, 'Add a picture of your ID and a selfie holding it.');
      await assertRealImages([idPhoto, selfie], 'One of the pictures is not a valid JPG, PNG, or WEBP image.');
      await saveUploads([idPhoto, selfie]);

      await withTx(async client => {
        const id = req.user.user_id;
        const u = await queryOne(client, 'SELECT verified_at, role, verify_code, verify_code_expires_at FROM users WHERE user_id = $1 FOR UPDATE', [id]);
        if (u.verified_at || u.role === 'admin') throw new HttpError(409, 'You are already verified.');
        if (!u.verify_code || new Date(u.verify_code_expires_at) < new Date()) {
          throw new HttpError(400, 'Your code expired. Get a new code and take the selfie again.');
        }
        const pending = await queryOne(client, `SELECT 1 FROM verifications WHERE user_id = $1 AND status = 'pending'`, [id]);
        if (pending) throw new HttpError(409, 'Your request is already being reviewed.');

        await client.query(
          `INSERT INTO verifications (user_id, typed_name, typed_first_name, typed_last_name, id_type, code, id_file, selfie_file)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, typed, first, last, idType, u.verify_code, idPhoto.filename, selfie.filename]
        );
        await client.query('UPDATE users SET verify_code = NULL, verify_code_expires_at = NULL WHERE user_id = $1', [id]);
        await logActivity(client, id, null, 'verification_submitted', idType);
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      await removeFiles(files);
      if (err.code === '23505') throw new HttpError(409, 'Your request is already being reviewed.');
      throw err;
    }
  }));


  // A verification picture. Only its owner and admins can open it, and only while it is being reviewed.
  app.get('/api/verifications/:id/:kind', auth, route(async (req, res) => {
    if (!isDbId(req.params.id) || !['id', 'selfie'].includes(req.params.kind)) throw new HttpError(404, 'File not found.');
    const v = await queryOne(pool, 'SELECT user_id, id_file, selfie_file FROM verifications WHERE verification_id = $1', [req.params.id]);
    const allowed = v && (sameId(v.user_id, req.user.user_id) || (await isAdmin(req.user.user_id)));
    const name = v && (req.params.kind === 'id' ? v.id_file : v.selfie_file);
    if (!allowed || !name) throw new HttpError(404, 'File not found.');

    sendPrivateImage(res, path.basename(name), VERIF_DIR, 'no-store');
  }));
}

module.exports = { register };
