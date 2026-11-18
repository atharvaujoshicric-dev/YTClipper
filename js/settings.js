// Settings: defaults, schema-driven editor, persistence helpers.
import { h, icon, toast, confirmDialog, clamp, fmtBytes, downloadBlob, modal } from './utils.js';
import { state, saveSettings, exportAllMetadata, importMetadata, clearAllData, refreshStorage } from './state.js';
import { CATEGORIES } from './event-classifier.js';
import { ffmpegStatus, initFFmpeg } from './export-engine.js';
import { DEFAULT_PHRASES } from './speech-analyzer.js';

export const DEFAULTS = {
  // clip extraction
  clipPreferred: 30, clipMin: 10, clipMax: 90, preRoll: 10, postRoll: 10, mergeGap: 8,
  // detection
  audioSensitivity: 50, visualSensitivity: 50, minScore: 50, maxCandidates: 12,
  visualInterval: 0.5, // seconds between sampled frames (analysis grid is 0.5s)
  speechEnabled: true, speechLang: 'en-US', customKeywords: [], disabledPhrases: [],
  enabledCategories: CATEGORIES.map((c) => c.id),
  weights: { audio: 25, visual: 20, speech: 20, unexpected: 20, scene: 10, prefs: 5 },
  // hooks
  hookStrategy: 'auto', // auto | A | B | C
  // captions
  captionsEnabled: true, captionTheme: 'white', captionFontSize: 64, captionOutline: true, captionBox: false, captionHighlight: true,
  // export
  exportResolution: '1080x1920', exportFormat: 'mp4', aspectRatio: '9:16', exportFps: 30, platform: 'both', cropMode: 'center',
  // live capture
  captureQuality: '1080p30', bufferMaxMB: 1500, liveAudio: true, liveAutoExport: true, liveFallback: true, liveFallbackSec: 60, liveMic: false,
  // storage
  storeMediaMaxMB: 400, audioDecodeMaxMB: 600,
  onboarded: false,
};

export const mergeSettings = (saved) => ({ ...DEFAULTS, ...(saved || {}), weights: { ...DEFAULTS.weights, ...(saved?.weights || {}) } });

function field(label, input, help) {
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, help ? h('span', { class: 'help' }, help) : null);
}

export function mount(root) {
  const s = state.settings;
  const set = async (patch) => { await saveSettings(patch); };
  const num = (key, min, max, step = 1) => h('input', { type: 'number', min, max, step, value: s[key], onchange: (e) => set({ [key]: clamp(+e.target.value, min, max) }) });
  const range = (key, min, max, step = 1, suffix = '') => {
    const out = h('b', {}, s[key] + suffix);
    const inp = h('input', { type: 'range', min, max, step, value: s[key], oninput: (e) => { out.textContent = e.target.value + suffix; }, onchange: (e) => set({ [key]: +e.target.value }) });
    return h('div', {}, h('div', { class: 'row between small muted' }, h('span'), out), inp);
  };
  const sel = (key, opts) => h('select', { onchange: (e) => set({ [key]: e.target.value !== '' && !isNaN(+e.target.value) ? +e.target.value : e.target.value }) }, opts.map(([v, l]) => h('option', { value: v, selected: String(s[key]) === String(v) }, l)));
  const chk = (key, label, help) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s[key], onchange: (e) => set({ [key]: e.target.checked }) }), h('div', {}, label, help ? h('div', { class: 'help' }, help) : null));

  // keywords
  const kwBox = h('div', { class: 'kw-list' });
  const renderKw = () => {
    kwBox.innerHTML = '';
    state.settings.customKeywords.forEach((k) => kwBox.append(h('span', { class: 'tag orange' }, k, h('button', { 'aria-label': 'Remove', onclick: async () => { await set({ customKeywords: state.settings.customKeywords.filter((x) => x !== k) }); renderKw(); } }, '×'))));
    if (!state.settings.customKeywords.length) kwBox.append(h('span', { class: 'help' }, 'No custom keywords yet.'));
  };
  const kwInput = h('input', { type: 'text', placeholder: 'e.g. "that was insane"', onkeydown: async (e) => { if (e.key === 'Enter') add(); } });
  const add = async () => { const v = kwInput.value.trim().toLowerCase(); if (!v) return; if (!state.settings.customKeywords.includes(v)) await set({ customKeywords: [...state.settings.customKeywords, v] }); kwInput.value = ''; renderKw(); };
  renderKw();

  // default phrases toggles
  const phrases = h('div', { class: 'kw-list' });
  const renderPhrases = () => {
    phrases.innerHTML = '';
    DEFAULT_PHRASES.forEach((p) => {
      const off = state.settings.disabledPhrases.includes(p);
      phrases.append(h('button', { class: 'chip' + (off ? '' : ' on'), onclick: async () => { const d = new Set(state.settings.disabledPhrases); off ? d.delete(p) : d.add(p); await set({ disabledPhrases: [...d] }); renderPhrases(); } }, p));
    });
  };
  renderPhrases();

  // weights
  const wBox = h('div', { class: 'weights' });
  const wNames = { audio: 'Audio excitement', visual: 'Visual activity', speech: 'Speech / reaction', unexpected: 'Unexpected activity', scene: 'Scene / context change', prefs: 'User preferences' };
  const total = h('b', {});
  const renderW = () => {
    wBox.innerHTML = '';
    Object.keys(wNames).forEach((k) => {
      const val = h('b', {}, state.settings.weights[k] + '%');
      wBox.append(h('span', {}, wNames[k]), h('input', { type: 'range', min: 0, max: 60, value: state.settings.weights[k], oninput: (e) => { val.textContent = e.target.value + '%'; }, onchange: async (e) => { await set({ weights: { ...state.settings.weights, [k]: +e.target.value } }); renderW(); } }), val);
    });
    const sum = Object.values(state.settings.weights).reduce((a, b) => a + b, 0);
    total.textContent = `Weights sum to ${sum}% — they are normalised automatically when scoring.`;
  };
  renderW();

  // categories
  const catBox = h('div', { class: 'kw-list' });
  const renderCats = () => {
    catBox.innerHTML = '';
    CATEGORIES.forEach((c) => {
      const on = state.settings.enabledCategories.includes(c.id);
      catBox.append(h('button', { class: 'chip' + (on ? ' on' : ''), onclick: async () => { const e = new Set(state.settings.enabledCategories); on ? e.delete(c.id) : e.add(c.id); await set({ enabledCategories: [...e] }); renderCats(); } }, c.label));
    });
  };
  renderCats();

  // storage
  const stor = h('div', { class: 'stack' });
  const renderStor = async () => {
    const est = await refreshStorage();
    stor.innerHTML = '';
    stor.append(
      h('div', { class: 'row between' }, h('span', {}, 'Used by this site: ', h('b', {}, fmtBytes(est.usage)), est.quota ? ` of ~${fmtBytes(est.quota)} available` : ''),),
      est.quota ? h('div', { class: 'meter' }, h('i', { style: { width: Math.min(100, (est.usage / est.quota) * 100) + '%' } })) : null,
      h('div', { class: 'notice warn' }, icon('warn'), h('div', {}, 'Everything is stored in your browser (IndexedDB). Clearing site data, using private browsing or deleting browser history can permanently delete your projects, clips and settings. Export project metadata regularly.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { const blob = await exportAllMetadata(); downloadBlob(blob, 'clipforge-metadata-' + new Date().toISOString().slice(0, 10) + '.json'); toast('Metadata exported (videos are not included).', 'success'); } }, icon('download', 'sm'), 'Export metadata'),
        h('label', { class: 'btn' }, icon('upload', 'sm'), 'Import metadata', h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: async (e) => { const f = e.target.files[0]; if (!f) return; try { const n = await importMetadata(f); toast(`Imported ${n.projects} project(s) and ${n.highlights} highlight(s). Re-link source videos from the Library if needed.`, 'success', 7000); renderStor(); } catch (err) { toast('Import failed: ' + err.message, 'error', 8000); } } })),
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Clear ALL local data?', 'This permanently deletes every project, recording, highlight, caption, feedback entry and export record stored in this browser. This cannot be undone.', { okText: 'Delete everything', danger: true })) { await clearAllData(); toast('All local data cleared.', 'success'); location.hash = '#/dashboard'; renderStor(); } } }, icon('trash', 'sm'), 'Clear all data'),
      ));
  };
  renderStor();

  // ffmpeg
  const ffBox = h('div', { class: 'stack' });
  const renderFF = () => {
    const st = ffmpegStatus();
    ffBox.innerHTML = '';
    ffBox.append(
      h('div', { class: 'row' }, h('span', { class: 'tag ' + ({ ready: 'green', failed: 'red', loading: 'orange', idle: '' }[st.state] || '') }, 'FFmpeg.wasm: ' + st.state), st.message ? h('span', { class: 'small muted' }, st.message) : null),
      st.codecs ? h('div', { class: 'small muted' }, `libx264: ${st.codecs.x264 ? 'yes' : 'no'} · aac: ${st.codecs.aac ? 'yes' : 'no'}`) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { try { await initFFmpeg(); toast('FFmpeg.wasm ready.', 'success'); } catch (e) { toast('FFmpeg failed to initialise: ' + e.message, 'error', 9000); } renderFF(); } }, icon('cpu', 'sm'), st.state === 'ready' ? 'Re-check FFmpeg' : 'Initialise FFmpeg now')),
      h('div', { class: 'help' }, 'FFmpeg.wasm (single-threaded, no SharedArrayBuffer) downloads ~31 MB from a CDN the first time MP4 transcoding is needed. Browsers with native MP4 recording skip it.'));
  };
  renderFF();

  root.append(
    h('div', { class: 'view-head fade-in' }, h('div', {}, h('h1', {}, icon('settings'), 'Settings'), h('p', { class: 'sub' }, 'Every detection, scoring, caption and export default lives here. Changes save instantly to your browser.')),
      h('div', { class: 'view-actions' }, h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Reset to defaults?', 'All settings return to their defaults. Projects and clips are not affected.', { okText: 'Reset', danger: true })) { await saveSettings({ ...DEFAULTS, onboarded: true }, true); toast('Settings reset.', 'success'); location.reload(); } } }, 'Reset to defaults'))),
    h('div', { class: 'stack fade-in' },
      h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Clip extraction')), h('div', { class: 'set-grid' },
        field('Preferred duration (s)', num('clipPreferred', 5, 180)), field('Minimum duration (s)', num('clipMin', 3, 120)), field('Maximum duration (s)', num('clipMax', 10, 300)),
        field('Pre-roll (s)', num('preRoll', 0, 60), 'Context kept before the event.'), field('Post-roll (s)', num('postRoll', 0, 60), 'Payoff / reaction kept after the event.'), field('Merge gap (s)', num('mergeGap', 0, 60), 'Events closer than this become one highlight.'),
        field('Max candidate clips', num('maxCandidates', 1, 100)), field('Minimum engagement score', num('minScore', 0, 100), 'Candidates below this are not created.'))),
      h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Detection sensitivity')), h('div', { class: 'set-grid' },
        field('Audio sensitivity', range('audioSensitivity', 0, 100)), field('Visual sensitivity', range('visualSensitivity', 0, 100)),
        field('Frame sampling interval', sel('visualInterval', [[0.5, 'Every 0.5 s (most precise)'], [1, 'Every 1 s'], [2, 'Every 2 s (fastest)']].map(([v, l]) => [String(v), l]))),
      ), h('div', { class: 'help', style: { marginTop: '8px' } }, 'Sensitivity changes how strongly a deviation from the recording’s own baseline counts. Re-run detection from AI Highlights to apply to existing projects.')),
      h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Engagement score weights')), wBox, h('div', { class: 'help', style: { marginTop: '8px' } }, total), h('div', { class: 'help' }, 'Signals that are unavailable (e.g. speech recognition for uploaded files) are excluded and the remaining weights are re-normalised, so a missing signal never silently caps the score.')),
      h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Speech & reaction keywords')),
        h('div', { class: 'stack' }, chk('speechEnabled', 'Enable speech recognition during live capture', 'Uses the browser’s Web Speech API (microphone). Chrome/Edge send audio to an online service; it is not guaranteed offline.'),
          field('Recognition language', h('input', { type: 'text', value: s.speechLang, onchange: (e) => set({ speechLang: e.target.value.trim() || 'en-US' }) }), 'BCP-47 tag, e.g. en-US, en-GB, es-ES.'),
          h('div', {}, h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Default phrases (click to toggle)'), phrases),
          h('div', {}, h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Custom keywords'), kwBox),
          h('div', { class: 'row' }, kwInput, h('button', { class: 'btn', onclick: add }, 'Add keyword')))),
      h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Event categories')), catBox, h('div', { class: 'help', style: { marginTop: '8px' } }, 'Disabled categories are never auto-assigned (you can still set them manually).')),
      h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Hooks, captions & export')), h('div', { class: 'set-grid' },
        field('Hook strategy', sel('hookStrategy', [['auto', 'Auto (best hook score)'], ['A', 'A — Action first'], ['B', 'B — Reaction first'], ['C', 'C — Context first']])),
        field('Caption theme', sel('captionTheme', [['white', 'White (yellow highlight)'], ['yellow', 'Yellow (white highlight)']])),
        field('Caption font size (px @1080w)', num('captionFontSize', 28, 140)),
        field('Export resolution', sel('exportResolution', [['1080x1920', '1080 × 1920 (Full HD)'], ['720x1280', '720 × 1280 (faster)']])),
        field('Export format', sel('exportFormat', [['mp4', 'MP4 (H.264 + AAC) — WebM fallback'], ['webm', 'WebM (fastest, always works)']])),
        field('Aspect ratio', sel('aspectRatio', [['9:16', '9:16 vertical']])),
        field('Default crop mode', sel('cropMode', [['center', 'Center crop'], ['follow', 'Follow subject (motion tracking)'], ['adjustable', 'Adjustable crop'], ['original', 'Original aspect (fit)'], ['blur', 'Blurred background']])),
        field('Preferred platform', sel('platform', [['both', 'Instagram Reels + YouTube Shorts'], ['reels', 'Instagram Reels'], ['shorts', 'YouTube Shorts']]))),
        h('div', { class: 'row', style: { marginTop: '12px' } }, chk('captionsEnabled', 'Captions on by default'), chk('captionOutline', 'Black outline'), chk('captionBox', 'Background box'), chk('captionHighlight', 'Word highlighting'))),
      h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Live capture')), h('div', { class: 'set-grid' },
        field('Capture quality', sel('captureQuality', [['720p30', '720p · 30 fps'], ['1080p30', '1080p · 30 fps'], ['1080p60', '1080p · 60 fps']])),
        field('Rolling buffer cap (MB)', num('bufferMaxMB', 100, 8000, 50), 'Oldest unprotected chunks are evicted above this.'),
        field('Keep source video in browser if ≤ (MB)', num('storeMediaMaxMB', 0, 4000, 50), 'Larger files stay in memory only; you re-link them after reload.'),
        field('Full audio decode up to (MB)', num('audioDecodeMaxMB', 1, 4000, 50), 'Bigger files use slower real-time (2×) audio analysis to save memory.')),
        h('div', { style: { marginTop: '12px' } }, chk('liveAutoExport', 'Auto-export live clips to 9:16 MP4', 'Each clip cut during a live capture is tracked, rendered and verified automatically so it is ready to download. Uses CPU while capturing.'))),
      h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'FFmpeg.wasm')), ffBox),
      h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Local storage')), stor)));
  return () => {};
}
