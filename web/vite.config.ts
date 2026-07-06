import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the local JSON API. API_PORT lets you match a
// non-default server PORT. The client itself is host-agnostic; it always calls
// same-origin /api, which the express static server also satisfies in prod.
const apiPort = process.env.API_PORT ?? '4000';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  server: {
    port: Number(process.env.CLIENT_PORT ?? 5173),
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
