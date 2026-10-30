import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { DEMO } from './api';

// Crashes in the panel go to the same error list as the apps' (no sign-in needed, nothing personal sent).
const sent = new Set<string>();
function report(err: unknown): void {
  if (DEMO) return;
  const e = err instanceof Error ? err : new Error(String(err));
  if (sent.has(e.message) || sent.size > 50) return;
  sent.add(e.message);
  fetch('/api/client-errors', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'admin', message: (e.message || 'Error').slice(0, 500), ...(e.stack ? { stack: e.stack.slice(0, 4000) } : {}), platform: 'web' }),
  }).catch(() => {});
}
window.addEventListener('error', (ev) => report(ev.error ?? ev.message));
window.addEventListener('unhandledrejection', (ev) => report(ev.reason));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
