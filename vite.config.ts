import { defineConfig } from 'vite';

// ビルドごとの識別子。アプリはこれと公開先の version.json を比べて、新しい版があれば更新を促す
const buildId = new Date().toISOString();

// base を相対にして GitHub Pages などサブパス配信でも動くようにする
export default defineConfig({
  base: './',
  server: { port: 5173 },
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    {
      name: 'version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: buildId }) });
      },
    },
  ],
});
