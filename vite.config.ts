import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// 받아쓰기 웹앱 dictweb1 — 정적 PWA. 모델(crnn ~32MB, gate 6.4MB)·OpenCV WASM 포함
// 전체 프리캐시 → 첫 로드 후 완전 오프라인 동작(업로드 제외) (지시문 §7).
export default defineConfig({
  base: './',
  optimizeDeps: {
    // esbuild 사전 번들이 ort의 import.meta.url 기반 wasm 경로를 깨뜨린다 — 원본 ESM 그대로 서빙
    exclude: ['onnxruntime-web'],
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 20000,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,onnx,json,png,svg,mjs,webmanifest}'],
        maximumFileSizeToCacheInBytes: 64 * 1024 * 1024,
      },
      manifest: {
        name: '받아쓰기 놀이터',
        short_name: '받아쓰기',
        description: '초등 1~2학년 손글씨 받아쓰기 학습 (dictweb1)',
        lang: 'ko',
        start_url: './',
        display: 'standalone',
        background_color: '#eaf6ff',
        theme_color: '#3a86ff',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
});
