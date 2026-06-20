import { defineConfig } from 'vite';
import { createRequire } from 'module';

// Reuse the exact fetch/validation logic the Vercel function uses, so dev and
// prod behave identically (the core is CommonJS — see api/_gdoc-core.js).
const require = createRequire(import.meta.url);
const { fetchDocxBytes } = require('./api/_gdoc-core.js');

// No framework plugin is registered on purpose: the app builds with Vite's
// esbuild defaults (the same behaviour as before this file existed — .jsx is
// transformed by esbuild and main.jsx imports React explicitly). This config
// exists only to add a dev-server route for /api/gdoc so the Google-Doc import
// works under `npm run dev`, mirroring the Vercel serverless function.
function gdocDevApi() {
  return {
    name: 'gdoc-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/gdoc', async (req, res) => {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
        const { status, buffer, error } = await fetchDocxBytes(id);
        if (error) {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.end(buffer);
      });
    },
  };
}

export default defineConfig({ plugins: [gdocDevApi()] });
