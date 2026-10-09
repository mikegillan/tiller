import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'ui',
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/ws': { target: process.env.O8_WS ?? 'http://127.0.0.1:7788', ws: true } } },
});
