// ---------- Remove hidden data from uploaded pictures ----------
// Phone photos carry hidden data: the GPS location where the photo was taken, the phone model,
// the date and time, editing software, comments, and sometimes a small copy of the original
// picture (or extra pictures after the main one). None of it is needed, and the location is
// private, so it is removed before a picture is kept. The picture itself is not re-compressed,
// so its quality does not change.
//
// One value is kept: which way up the photo is (EXIF "Orientation"). Without it, photos taken
// with the phone held upright would show sideways.
//
// JPEG, PNG and WEBP are cleaned. GIF is kept as it is: phones do not put a location in GIFs.
// A picture whose structure cannot be read throws, so it is refused instead of kept with its data.

class BadImage extends Error {}

const fail = why => { throw new BadImage(why); };


// ----- JPEG -----
// Segments to keep before the picture data: the basics a decoder needs, the colour profile
// (APP2 "ICC_PROFILE") and Adobe's colour flag (APP14). Every other APPn and every comment goes.
const ICC = Buffer.from('ICC_PROFILE\0', 'latin1');
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');

// Which way up the photo is, read from an EXIF block ("Exif\0\0" + TIFF). 1 (normal) or null when absent.
function readOrientation(app1) {
  if (app1.length < 14 || !app1.subarray(0, 6).equals(EXIF_HEADER)) return null;
  const tiff = app1.subarray(6);
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = o => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = o => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  try {
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {   // Orientation, type SHORT
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : null;
      }
    }
  } catch { /* a cut-off EXIF block: treat as no orientation */ }
  return null;
}

// A tiny EXIF block that holds nothing but the orientation
function orientationOnlyApp1(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);          // TIFF marker
  tiff.writeUInt32BE(8, 4);           // first directory right after the header
  tiff.writeUInt16BE(1, 8);           // one entry
  tiff.writeUInt16BE(0x0112, 10);     // Orientation
  tiff.writeUInt16BE(3, 12);          // type SHORT
  tiff.writeUInt32BE(1, 14);          // one value
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);          // no next directory
  const body = Buffer.concat([EXIF_HEADER, tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) fail('not a JPEG');
  const out = [buf.subarray(0, 2)];
  let orientation = null;
  let insertAt = 1;   // where the orientation block goes: after SOI, or after a leading APP0
  let pos = 2;

  while (pos < buf.length) {
    if (buf[pos] !== 0xff) fail('broken JPEG');
    while (buf[pos] === 0xff && pos < buf.length) pos++;   // fill bytes
    if (pos >= buf.length) fail('cut-off JPEG');
    const marker = buf[pos];
    const start = pos - 1;
    pos++;

    if (marker === 0xd9) {           // end of the picture: anything after it (extra pictures) is dropped
      out.push(Buffer.from([0xff, 0xd9]));
      if (orientation && orientation !== 1) out.splice(insertAt, 0, orientationOnlyApp1(orientation));
      return Buffer.concat(out);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {   // markers without a length
      out.push(buf.subarray(start, pos));
      continue;
    }
    if (pos + 2 > buf.length) fail('cut-off JPEG');
    const length = buf.readUInt16BE(pos);
    if (length < 2 || pos + length > buf.length) fail('broken JPEG segment');
    const end = pos + length;
    const data = buf.subarray(pos + 2, end);

    if (marker === 0xda) {
      // Start of the picture data: keep the header, then the coded data up to the next real marker
      out.push(buf.subarray(start, end));
      let scan = end;
      while (scan < buf.length) {
        if (buf[scan] === 0xff) {
          const next = buf[scan + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { scan += 2; continue; }   // a coded 0xFF, or a restart marker
          if (next === 0xff) { scan++; continue; }
          break;
        }
        scan++;
      }
      out.push(buf.subarray(end, scan));
      pos = scan;
      continue;
    }

    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xe1) {
      const found = readOrientation(data);
      if (found && !orientation) orientation = found;
    } else if (marker === 0xfe) {
      // a comment: dropped
    } else if (isApp && marker !== 0xe0 && marker !== 0xee && !(marker === 0xe2 && data.subarray(0, ICC.length).equals(ICC))) {
      // other application data (MPF extra pictures, IPTC, Photoshop, XMP, makers' notes): dropped
    } else {
      out.push(buf.subarray(start, end));
      if (marker === 0xe0 && out.length === 2) insertAt = 2;
    }
    pos = end;
  }
  fail('JPEG has no end');
}


// ----- PNG -----
// Text chunks, the EXIF chunk and the "last changed" time go. Everything after IEND goes.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) fail('not a PNG');
  const out = [PNG_SIGNATURE];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (end > buf.length) fail('broken PNG chunk');
    if (!PNG_DROP.has(type)) out.push(buf.subarray(pos, end));
    pos = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  fail('PNG has no end');
}


// ----- WEBP -----
// The EXIF and XMP chunks go, and the extended header no longer says they are there.
function stripWebp(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') fail('not a WEBP');
  const declared = buf.readUInt32LE(4) + 8;
  if (declared > buf.length) fail('cut-off WEBP');
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= declared) {
    const fourcc = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const end = pos + 8 + size + (size % 2);
    if (pos + 8 + size > declared) fail('broken WEBP chunk');
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      let chunk = buf.subarray(pos, Math.min(end, declared));
      if (fourcc === 'VP8X') {
        chunk = Buffer.from(chunk);
        chunk[8] &= ~(0x08 | 0x04);   // the flags: no EXIF, no XMP
      }
      chunks.push(chunk);
    }
    pos = end;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}


// The cleaned picture. `ext` is the file's extension (.jpg, .png, .webp, .gif).
function stripImage(buf, ext) {
  if (ext === '.jpg') return stripJpeg(buf);
  if (ext === '.png') return stripPng(buf);
  if (ext === '.webp') return stripWebp(buf);
  return buf;
}

module.exports = { BadImage, stripImage, stripJpeg, stripPng, stripWebp, readOrientation, orientationOnlyApp1 };
