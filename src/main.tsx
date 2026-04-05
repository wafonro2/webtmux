import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    let hasReloadedForNewWorker = false;
    const triggerReloadOnce = () => {
      if (hasReloadedForNewWorker) {
        return;
      }
      hasReloadedForNewWorker = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      triggerReloadOnce();
    });

    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        if (registration.waiting) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }

        registration.addEventListener('updatefound', () => {
          const nextWorker = registration.installing;
          if (!nextWorker) {
            return;
          }

          nextWorker.addEventListener('statechange', () => {
            if (
              nextWorker.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              nextWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });

        registration.update().catch(() => {});
        window.setInterval(() => {
          registration.update().catch(() => {});
        }, 60_000);
      })
      .catch((error) => {
        console.error('Service worker registration failed:', error);
      });
  });
}
