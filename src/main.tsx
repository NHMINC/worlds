import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

/**
 * GitHub Pages caches every file for 10 minutes, including sw.js. The
 * default SW registration uses that HTTP cache, so a new deploy is
 * invisible until the CDN expires — and the old worker keeps serving
 * the previous HTML/JS from Cache Storage after that. Bypass the HTTP
 * cache for the worker script, poll for updates, and reload once a
 * new worker takes control.
 */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const id = import.meta.env.VITE_BUILD_ID || 'dev';
  const url = `${import.meta.env.BASE_URL}sw.js?v=${id}`;
  void navigator.serviceWorker
    .register(url, { scope: import.meta.env.BASE_URL, updateViaCache: 'none' })
    .then((reg) => {
      void reg.update();
      setInterval(() => {
        void reg.update();
      }, 5 * 60 * 1000);
    });
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      location.reload();
    });
  }
}

// GitHub Pages sends Access-Control-Allow-Origin: * and no X-Frame-Options,
// so clickjacking has to be stopped in the page. Do not boot inside a frame.
if (window.top !== window.self) {
  try {
    window.top!.location.replace(window.location.href);
  } catch {
    document.documentElement.textContent = '';
  }
} else {
  if (import.meta.env.PROD) registerServiceWorker();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
