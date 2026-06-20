// Shared core for the Google-Doc → .docx proxy, used by BOTH the Vercel
// serverless function (api/gdoc.js) and the Vite dev middleware
// (vite.config.js). Files in api/ that start with "_" are not routes but are
// bundled for import, so this single copy keeps the two entry points in sync.

// Pull the document id from a share link (…/document/d/<ID>/…), an open/export
// URL (?id=<ID>), or accept a bare id. Returns '' when nothing usable is found.
function extractId(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
}

// A .docx is a zip; every valid one opens with the "PK\x03\x04" local-file
// header. We check this so an HTML sign-in / virus-scan / "not found" page is
// never mistaken for a real file and passed on to the unzipper.
function isDocxZip(buf) {
  return !!buf && buf.length >= 4 &&
    buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

// Fetch a PUBLIC Doc/Drive file as .docx bytes. Two endpoints are tried because
// the same /document/d/<id>/ URL covers two different storage types:
//   1. a NATIVE Google Doc  → only the Docs export endpoint returns a .docx;
//   2. a Word .docx UPLOADED to Drive (the ".DOCX" badge case) → that export
//      endpoint returns non-zip data, so the Drive direct-download is used.
// Each result is validated by zip magic, so we return the first real .docx.
async function fetchDocxBytes(idRaw) {
  const id = extractId(idRaw);
  if (!id) return { status: 400, error: 'Missing or invalid Google Doc link/id.' };
  const urls = [
    `https://docs.google.com/document/d/${id}/export?format=docx`,
    `https://drive.google.com/uc?export=download&id=${id}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (isDocxZip(buf)) return { status: 200, buffer: buf };
    } catch { /* try the next endpoint */ }
  }
  return { status: 403, error: 'Could not read the document as .docx. Make sure the link is shared "Anyone with the link can view" (and is a Doc or an uploaded .docx).' };
}

module.exports = { extractId, isDocxZip, fetchDocxBytes };
