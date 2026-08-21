import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** GitHub Pages cannot set CSP HTTP headers; inject a meta policy on the production build only (dev HMR needs eval / websockets). */
const CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://api.x.ai",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

function securityMeta(): Plugin {
  return {
    name: 'security-meta',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig(({ command }) => ({
  // GitHub Pages project site lives at /worlds/; Capacitor and local stay at /.
  base: process.env.BASE_PATH || '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Register from main.tsx so production CSP can omit 'unsafe-inline',
      // and so we can set updateViaCache: 'none' (GitHub Pages caches sw.js).
      injectRegister: false,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      manifest: {
        name: 'Hex Worlds',
        short_name: 'Hex Worlds',
        description: 'A calm hex world builder with infinite zoom',
        theme_color: '#152238',
        background_color: '#152238',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
    ...(command === 'build' ? [securityMeta()] : []),
  ],
}));
