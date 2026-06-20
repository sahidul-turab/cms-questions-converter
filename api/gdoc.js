// Vercel serverless proxy: fetch a PUBLIC Google Doc (or an uploaded .docx) as
// a .docx, server-side. The browser cannot fetch Google directly (no CORS
// headers), so the app calls /api/gdoc?id=<docId|link> and we fetch here, then
// stream the .docx bytes back. Those bytes flow through the existing
// docxToContent() pipeline (OMML math + embedded images) exactly like an
// uploaded file. See _gdoc-core.js for the endpoint/validation logic.

const { fetchDocxBytes } = require('./_gdoc-core.js');

module.exports = async (req, res) => {
  const { status, buffer, error } = await fetchDocxBytes((req.query && req.query.id) || '');
  if (error) { res.status(status).json({ error }); return; }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(buffer);
};
