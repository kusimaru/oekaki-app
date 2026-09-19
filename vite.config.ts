import { defineConfig } from 'vite';

// base を相対にして GitHub Pages などサブパス配信でも動くようにする
export default defineConfig({
  base: './',
  server: { port: 5173 },
});
