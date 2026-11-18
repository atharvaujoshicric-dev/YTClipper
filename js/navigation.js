// Sidebar, hash router, top-bar widgets, help and onboarding.
import { h, icon, $, bus, modal, fmtBytes, toast } from './utils.js';
import { state, setCurrentProject, saveSettings, highlightsOf } from './state.js';
import { ffmpegStatus, initFFmpeg } from './export-engine.js';

export const ROUTES = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', load: () => import('./dashboard.js') },
  { id: 'live', label: 'Live Clipper', icon: 'live', load: () => import('./live-capture.js') },
  { id: 'library', label: 'Video Library', icon: 'library', load: () => import('./library.js') },
  { id: 'highlights', label: 'AI Highlights', icon: 'spark', load: () => import('./highlights.js') },
  { id: 'hooks', label: 'Hook Intelligence', icon: 'hook', load: () => import('./hook-intelligence.js') },
  { id: 'editor', label: 'Clip Editor', icon: 'scissors', load: () => import('./video-editor.js') },
  { id: 'export', label: 'Export Center', icon: 'export', load: () => import('./export-center.js') },
  { id: 'analytics', label: 'Analytics', icon: 'chart', load: () => import('./analytics.js') },
  { id: 'settings', label: 'Settings', icon: 'settings', load: () => import('./settings.js') },
];

let unmount = null, token = 0;
export async function renderRoute() {
  const id = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  const route = ROUTES.find((r) => r.id === id) || ROUTES[0];
  const my = ++token; const view = $('#view');
  try { unmount?.(); } catch (e) { console.error(e); } unmount = null;
  view.innerHTML = ''; $('#main').scrollTop = 0;
  document.title = `${route.label} · GTA 6 CLIPFORGE`;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route.id));
  document.body.classList.remove('sidebar-open');
  try {
    const mod = await route.load(); if (my !== token) return;
    const res = await mod.mount(view); if (my !== token) { res?.(); return; }
    unmount = typeof res === 'function' ? res : null;
  } catch (e) {
    console.error(e);
    view.append(h('div', { class: 'card pad stack' }, h('h2', {}, 'This page could not load'), h('div', { class: 'notice err' }, icon('warn'), e.message || String(e)), h('div', {}, h('a', { class: 'btn', href: '#/dashboard' }, 'Back to dashboard'))));
  }
}

export function initNavigation() {
  const nav = $('#sidebar');
  nav.innerHTML = '';
  ROUTES.forEach((r) => nav.append(h('a', { class: 'nav-item', href: '#/' + r.id, dataset: { route: r.id }, 'data-tip': r.label }, icon(r.icon), h('span', { class: 'nav-label' }, r.label), r.id === 'highlights' ? h('span', { class: 'nav-badge hidden', id: 'badge-highlights' }) : null)));
  nav.append(h('div', { class: 'sidebar-foot' }, 'Process only footage you own or may republish. Everything runs locally in your browser.'));
  $('#sidebar-toggle').addEventListener('click', () => {
    if (window.innerWidth <= 860) document.body.classList.toggle('sidebar-open');
    else { document.body.classList.toggle('sidebar-collapsed'); localStorage.setItem('clipforge.collapsed', document.body.classList.contains('sidebar-collapsed') ? '1' : ''); }
  });
  if (localStorage.getItem('clipforge.collapsed')) document.body.classList.add('sidebar-collapsed');
  window.addEventListener('hashchange', renderRoute);
  initTopbar();
  $('#help-btn').addEventListener('click', showHelp);
}

function initTopbar() {
  const sel = $('#project-select');
  const drawProjects = () => {
    sel.innerHTML = '';
    const ps = [...state.projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!ps.length) sel.append(h('option', { value: '' }, 'No project — import a recording'));
    ps.forEach((p) => sel.append(h('option', { value: p.id, selected: p.id === state.currentProjectId }, p.name)));
    const b = $('#badge-highlights'); const n = state.currentProjectId ? highlightsOf(state.currentProjectId).filter((x) => x.status === 'candidate').length : 0;
    if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
  };
  sel.addEventListener('change', () => { if (sel.value) { setCurrentProject(sel.value); renderRoute(); } });
  bus.on('change', drawProjects); drawProjects();

  const chip = $('#processing-chip'), txt = $('#processing-text'), dot = $('#processing-dot'), bar = $('#processing-bar i');
  const drawProc = (p = state.processing) => {
    txt.textContent = p.active ? `${p.label}${p.pct ? ' · ' + p.pct + '%' : ''}` : p.error ? 'Error: ' + p.label : p.label || 'Idle';
    chip.classList.toggle('busy', !!p.active); chip.classList.toggle('err', !!p.error && !p.active); chip.classList.toggle('ok', !p.active && !p.error && p.label && p.label !== 'Idle');
    bar.style.width = (p.active ? p.pct : 0) + '%';
    chip.dataset.tip = p.active ? (p.cancel ? 'Click to cancel this task' : 'Working…') : p.error || 'Processing status';
  };
  bus.on('processing', drawProc); drawProc();
  chip.addEventListener('click', async () => { const p = state.processing; if (p.active && p.cancel) { p.cancel(); toast('Cancelling…', 'info', 1500); } });

  const fft = $('#ffmpeg-text');
  const drawFF = (s = ffmpegStatus()) => { fft.textContent = 'FFmpeg: ' + ({ idle: 'idle', loading: 'loading' + (s.progress ? ' ' + Math.round(s.progress * 100) + '%' : '…'), ready: 'ready', failed: 'unavailable' }[s.state]); $('#ffmpeg-chip').dataset.tip = s.message || 'FFmpeg.wasm loads on first MP4 transcode. Click to load it now.'; };
  bus.on('ffmpeg', drawFF); drawFF();
  $('#ffmpeg-chip').addEventListener('click', async () => { if (ffmpegStatus().state === 'ready') return toast('FFmpeg.wasm is ready.', 'success'); try { toast('Loading FFmpeg.wasm…', 'info', 2500); await initFFmpeg(); toast('FFmpeg.wasm ready.', 'success'); } catch (e) { toast('FFmpeg could not load: ' + e.message, 'error', 8000); } });

  const st = $('#storage-text'); const drawSt = () => { st.textContent = state.storage.unknown ? 'Storage' : fmtBytes(state.storage.usage) + (state.storage.quota ? ' / ' + fmtBytes(state.storage.quota) : ''); };
  bus.on('storage', drawSt); drawSt();
  $('#storage-chip').addEventListener('click', () => (location.hash = '#/settings'));
}

export function showHelp() {
  modal({ title: 'How ClipForge works', wide: true, body: h('div', { class: 'stack' },
    h('ol', { class: 'help-steps' },
      ...[['Import', 'Upload an MP4 / WebM / MOV you own, or capture a tab / window / screen you are allowed to record (Live Clipper).'], ['Analyse', 'Audio energy, frame-to-frame motion and (live) spoken reactions are measured locally in your browser.'], ['Detect & rank', 'Peaks across several signals become highlight candidates with an explainable 0–100 engagement-potential score.'], ['Review', 'Approve, reject, re-categorise and leave feedback. Feedback tunes ranking through simple local rules.'], ['Hook', 'Compare three opening strategies and pick the strongest first 1–3 seconds.'], ['Edit', 'Trim, crop to 9:16, add captions and text. The preview is the real renderer.'], ['Export', 'Render 1080×1920 clips with verification, copy suggested metadata, download singly or as a ZIP. You publish manually.']].map(([t, d]) => h('li', {}, h('div', {}, h('b', {}, t + ' — '), d)))),
    h('div', { class: 'notice warn' }, icon('warn'), 'Viewing a stream is not the same as having permission to republish it. Only process and publish footage you own or are authorised to use. ClipForge does not download from URLs, circumvent DRM, or publish anything for you.'),
    h('div', { class: 'help' }, 'Scores estimate engagement potential from audio/visual activity. They do not predict views, retention or virality.')) });
}

export function maybeOnboard() {
  if (state.settings.onboarded) return;
  const m = modal({ title: 'Welcome to GTA 6 CLIPFORGE', wide: true, onClose: () => saveSettings({ onboarded: true }),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Turn long gameplay recordings and live sessions into short, vertical highlights — entirely inside your browser. No account, no server, nothing is uploaded.'),
      h('ol', { class: 'help-steps' }, ...[['Add footage', 'Drop a recording in the Video Library or start the Live Clipper.'], ['Let it analyse', 'ClipForge scores audio, motion and reactions to find the moments worth clipping.'], ['Pick, polish, export', 'Choose a hook, tweak captions, and download Reels / Shorts-ready video.']].map(([t, d]) => h('li', {}, h('div', {}, h('b', {}, t + ' — '), d)))),
      h('div', { class: 'notice warn' }, icon('warn'), 'Only use footage you own or have explicit permission to capture and republish. Your projects live in this browser; clearing site data deletes them — export metadata from Settings now and then.')),
    footer: [h('button', { class: 'btn', onclick: () => { m.close(); location.hash = '#/library'; } }, 'Import a recording'), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Get started')] });
}
