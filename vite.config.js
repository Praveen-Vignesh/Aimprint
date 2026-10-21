import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Stamp the app version onto every session row (constants.js reads
// __APP_VERSION__). Sourced from package.json so a release bump is the single
// place it changes; falls back to 'dev' outside a Vite build (Node harnesses).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

export default defineConfig({
  // Absolute asset paths. These were relative ('./') so dist/ could run from any
  // subpath, but the site is permanently at the root of aimprint.vercel.app and
  // relative paths break under clean URLs: at /play/ a './assets/x.js' resolves
  // to /play/assets/x.js and 404s. Absolute removes that failure mode entirely.
  // The only cost is that opening dist/index.html over file:// stops working,
  // which was never a supported way to run this.
  base: '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  build: {
    // Three.js alone exceeds the default 500 kB advisory limit, and it is needed
    // on the first frame, so splitting it out would move bytes without saving any.
    chunkSizeWarningLimit: 800,
    // Multi-page, not a router. Four entries with distinct payloads:
    // index.html is the landing page and loads only the Supabase client,
    // play.html is the game and is the only page that pulls in Three,
    // privacy.html is a static document with no JS, and status.html is a small
    // standalone model-status dashboard (fetch only, no Three, no Supabase).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        play: fileURLToPath(new URL('./play.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./privacy.html', import.meta.url)),
        status: fileURLToPath(new URL('./status.html', import.meta.url))
      }
    }
  }
});
