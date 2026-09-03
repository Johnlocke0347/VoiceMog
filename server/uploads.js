// uploads.js — treats every uploaded file as hostile. Validates by magic
// bytes (not the client-reported mimetype, which is trivially spoofed)
// and enforces a hard size cap. Does NOT touch the filesystem — avatar
// bytes are handed back to the caller to store in Postgres (see db.js
// setAvatarData), so they survive a redeploy the same way every other
// player fact now does. A local-disk avatar would just be a second place
// for "ephemeral filesystem" to quietly bite us.
const MAX_BYTES = 2 * 1024 * 1024; // 2MB

const SIGNATURES = [
  { ext: 'jpg',  mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { ext: 'png',  mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { ext: 'webp', mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, extraCheck: (buf) =>
      buf.length > 11 && buf.toString('ascii', 8, 12) === 'WEBP' },
];

function sniff(buf){
  for(const sig of SIGNATURES){
    const off = sig.offset || 0;
    const matches = sig.bytes.every((b, i) => buf[off+i] === b);
    if(matches && (!sig.extraCheck || sig.extraCheck(buf))) return sig;
  }
  return null;
}

// Validates a Buffer, throws a descriptive Error if rejected. Returns
// { mime } on success — the caller persists the bytes wherever it wants
// (a database row, here).
function validateAvatar(buffer){
  if(!buffer || buffer.length === 0) throw new Error('EMPTY_FILE');
  if(buffer.length > MAX_BYTES) throw new Error('FILE_TOO_LARGE');
  const sig = sniff(buffer);
  if(!sig) throw new Error('UNSUPPORTED_FILE_TYPE');
  return { mime: sig.mime };
}

module.exports = { validateAvatar, MAX_BYTES };
