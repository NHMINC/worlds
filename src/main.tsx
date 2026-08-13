import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './styles.css';

// GitHub Pages sends Access-Control-Allow-Origin: * and no X-Frame-Options,
// so clickjacking has to be stopped in the page. Do not boot inside a frame.
if (window.top !== window.self) {
  try {
    window.top!.location.replace(window.location.href);
  } catch {
    document.documentElement.textContent = '';
  }
} else {
  if (import.meta.env.PROD) registerSW({ immediate: true });
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
