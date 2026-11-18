// Dashboard — every number derives from real local data. Empty states for new users.
import { h, icon, fmtBytes, fmtDur, fmtDate, fmtTime, emptyState, scoreBadge, bus } from './utils.js';
import { state, highlightsOf } from './state.js';
import { categoryLabel } from './event-classifier.js';
import { speechSupported } from './speech-analyzer.js';
import { exportCapabilities } from './export-engine.js';

export function capabilityReport() {
  const c = exportCapabilities();
  const mk = (name, ok, note) => ({ name, ok, note });
  return [
    mk('Screen capture (getDisplayMedia)', !!navigator.mediaDevices?.getDisplayMedia, 'Needed for Live Clipper (desktop browsers, HTTPS or localhost).'),
    mk('MediaRecorder', !!window.MediaRecorder, 'Records the capture and renders exports.'),
    mk('Canvas captureStream', !!HTMLCanvasElement.prototype.captureStream, 'Needed to render vertical exports.'),
    mk('Web Audio + AudioWorklet', !!(window.AudioContext && window.AudioWorklet), 'Audio analysis (falls back to ScriptProcessor live).'),
    mk('Web Speech recognition', speechSupported(), 'Optional: spoken reaction keywords during live capture.'),
    mk('IndexedDB', !!window.indexedDB, 'Projects and settings persistence.'),
    mk('Web Workers (module)', !!window.Worker, 'Keeps audio analysis off the UI thread.'),
    mk('Native MP4 recording', c.nativeMp4, 'If missing, MP4 is transcoded with FFmpeg.wasm (or WebM is delivered).'),
    mk('WebAssembly', typeof WebAssembly === 'object', 'Required for FFmpeg.wasm.'),
  ];
}

export function mount(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('div', { class: 'view-head fade-in' }, h('div', {}, h('h1', {}, icon('dashboard'), 'Dashboard'), h('p', { class: 'sub' }, 'Turn Gameplay Into Highlights. Everything below is calculated from the projects stored in this browser — nothing is estimated or invented.'))), body);
  const off = bus.on('change', draw); const off2 = bus.on('storage', draw);
  draw();
  function draw() {
    body.innerHTML = '';
    const projects = [...state.projects.values()]; const hls = [...state.highlights.values()]; const analyzed = projects.filter((p) => p.status === 'analyzed');
    const exceptional = hls.filter((x) => x.score >= 90).length; const ready = hls.filter((x) => x.status === 'approved').length;
    const dur = analyzed.reduce((a, p) => a + (p.duration || 0), 0); const avg = hls.length ? hls.reduce((a, x) => a + x.score, 0) / hls.length : null;
    const stat = (k, v, s) => h('div', { class: 'card stat-card' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 's' }, s));
    body.append(
      h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Workflow')), h('div', { class: 'workflow' }, ...[['IMPORT', 'Upload or capture', '#/library'], ['ANALYZE', 'Audio · visual · speech', '#/library'], ['DETECT', 'Find moments', '#/highlights'], ['RANK', 'Explainable score', '#/highlights'], ['REVIEW', 'Approve / reject', '#/highlights'], ['EDIT', 'Trim · crop · captions', '#/editor'], ['EXPORT', '9:16 MP4 / WebM', '#/export']].map(([t, s, href], i) => h('a', { class: 'wf-step', href }, h('b', {}, i + 1), t, h('small', {}, s))))),
      h('div', { class: 'quick' }, h('a', { class: 'btn primary', href: '#/live' }, icon('rec', 'sm'), 'Start Live Capture'), h('a', { class: 'btn', href: '#/library' }, icon('upload', 'sm'), 'Upload Recording'), h('a', { class: 'btn', href: '#/library' }, icon('library', 'sm'), 'Open Video Library'), h('a', { class: 'btn', href: '#/highlights' }, icon('spark', 'sm'), 'Review Highlights')),
      h('div', { class: 'grid cols-5' }, stat('Recordings processed', analyzed.length, `${projects.length} project(s) total`), stat('Highlights generated', hls.length, `${hls.filter((x) => x.manual).length} added manually`), stat('Exceptional clips', exceptional, 'score 90–100'), stat('Ready to export', ready, 'approved clips'), stat('Video analysed', fmtDur(dur) || '0s', 'total duration'),),
      h('div', { class: 'grid cols-3' }, stat('Avg engagement score', avg == null ? '—' : avg.toFixed(1), 'heuristic potential, not views'), stat('Exports completed', state.exportsLog.filter((e) => e.status === 'done').length, `${state.exportsLog.filter((e) => e.status === 'failed').length} failed`), stat('Browser storage', fmtBytes(state.storage.usage), state.storage.quota ? `of ~${fmtBytes(state.storage.quota)} available` : 'quota unknown')),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Recent projects'), h('a', { class: 'small', href: '#/library' }, 'View all')),
          projects.length ? h('div', { class: 'list' }, projects.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5).map((p) => h('a', { class: 'list-item', href: '#/library', onclick: () => { state.currentProjectId = p.id; } }, h('div', { class: 'thumb', style: { backgroundImage: p.thumb ? `url(${p.thumb})` : 'none' } }, h('span', { class: 'dur' }, fmtTime(p.duration))), h('div', { class: 'li-main' }, h('div', { class: 't' }, p.name), h('div', { class: 'm' }, `${p.status} · ${highlightsOf(p.id).length} highlights · ${fmtBytes(p.size)}`))))) : emptyState('library', 'No projects yet', 'Upload an authorised gameplay recording or start a live capture to begin.', [h('a', { class: 'btn primary', href: '#/library' }, 'Upload recording')])),
        h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Recent highlights'), h('a', { class: 'small', href: '#/highlights' }, 'Review')),
          hls.length ? h('div', { class: 'list' }, hls.sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map((x) => h('a', { class: 'list-item', href: '#/highlights', onclick: () => { state.currentProjectId = x.projectId; } }, h('div', { class: 'thumb', style: { backgroundImage: x.thumb ? `url(${x.thumb})` : 'none' } }), h('div', { class: 'li-main' }, h('div', { class: 't' }, x.title), h('div', { class: 'm' }, `${categoryLabel(x.category)} · ${fmtTime(x.start)}–${fmtTime(x.end)}`)), scoreBadge(x.score)))) : emptyState('spark', 'No highlights yet', 'Highlights appear after a recording has been analysed.')),
      ),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Processing history')), state.history.length ? h('div', { class: 'list' }, state.history.slice(0, 8).map((e) => h('div', { class: 'list-item' }, h('span', { class: 'tag ' + ({ success: 'green', failed: 'red', cancelled: 'orange', started: 'blue' }[e.status] || '') }, e.type), h('div', { class: 'li-main' }, h('div', { class: 't' }, e.message), h('div', { class: 'm' }, fmtDate(e.ts) + (e.projectName ? ' · ' + e.projectName : '')))))) : h('div', { class: 'help' }, 'Imports, analyses, captures and exports are logged here.')),
        h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Browser capability check')), h('div', { class: 'list' }, capabilityReport().map((c) => h('div', { class: 'list-item', style: { padding: '6px 0' } }, h('span', { class: 'tag ' + (c.ok ? 'green' : 'orange') }, c.ok ? 'ok' : 'missing'), h('div', { class: 'li-main' }, h('div', { class: 't' }, c.name), h('div', { class: 'm' }, c.note))))))));
  }
  return () => { off(); off2(); };
}
