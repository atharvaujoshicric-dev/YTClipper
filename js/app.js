// GTA 6 ClipForge — application bootstrap.
import { loadAll, state, requestPersistence } from './state.js';
import { initNavigation, renderRoute, maybeOnboard } from './navigation.js';
import { initTooltips, toast, h, icon } from './utils.js';

let lastErr = 0;
function reportError(msg) { const now = Date.now(); if (now - lastErr < 3000) return; lastErr = now; toast('Unexpected error: ' + msg, 'error', 7000); }
window.addEventListener('error', (e) => { console.error(e.error || e.message); if (!/ResizeObserver/.test(e.message || '')) reportError(e.message || 'script error'); });
window.addEventListener('unhandledrejection', (e) => { const r = e.reason; if (r?.name === 'AbortError') return; console.error(r); reportError(r?.message || String(r)); });

async function boot() {
  initTooltips();
  await loadAll();
  initNavigation();
  if (state.dbError) document.getElementById('view').before(h('div', { class: 'notice err', style: { marginBottom: '14px' } }, icon('warn'), 'Local storage (IndexedDB) is unavailable — private browsing or a blocked setting. You can still analyse and export during this session, but nothing will be saved. ' + state.dbError.message));
  if (!location.hash) location.hash = '#/dashboard';
  await renderRoute();
  maybeOnboard();
  requestPersistence();
  window.__clipforge = { state, ready: true }; // exposed for automated testing
}
boot().catch((e) => { console.error(e); document.getElementById('view').innerHTML = '<div class="card pad"><h2>ClipForge failed to start</h2><p class="muted">' + String(e.message || e).replace(/</g, '&lt;') + '</p></div>'; });
