// SPDX-License-Identifier: AGPL-3.0-only
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [svelte()],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  server: {
    // `npm run dev:web` proxies the API to `wrangler dev` on port 8787.
    proxy: { '/api': 'http://localhost:8787' },
  },
});
