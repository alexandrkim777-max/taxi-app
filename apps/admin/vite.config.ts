import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The panel is served next to the API on the same domain (/admin and /api behind one proxy),
// so no CORS is needed and the session never goes to another origin. In development Vite
// proxies /api to the local API. The demo build answers from an in-browser mock instead;
// the real build swaps that mock for an empty stub so sample data never ships.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  define: { __DEMO__: JSON.stringify(mode === 'demo') },
  resolve: {
    alias: mode === 'demo' ? [] : [{ find: /^\.\/mock$/, replacement: fileURLToPath(new URL('./src/mock.prod.ts', import.meta.url)) }],
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  build: { outDir: mode === 'demo' ? 'dist-demo' : 'dist', sourcemap: false, modulePreload: false },
}));
