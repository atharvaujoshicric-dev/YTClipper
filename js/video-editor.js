// Smart Clip Editor: live 9:16 preview (same compositor as export), timeline, trim, crop, audio, captions, text, hook.
import { h, icon, fmtTime, toast, clamp, debounce, uid, loadVideo, disposeVideo, seekTo, emptyState, downloadBlob, modal, scoreBadge, safeName } from './utils.js';
import { state, currentProject, highlightsOf, saveHighlight, saveHighlights, getMediaUrl, getTimeline } from './state.js';
import { renderFrame } from './compositor.js';
import { segmentsOf, outDuration, outToSrc, srcToOut, generateHooks, overlaySuggestions } from './hook-intelligence.js';
import { CROP_MODES, suggestCropX, SAFE } from './crop-engine.js';
import { THEMES, newCaption, captionsFromText, parseSubtitles, toSRT, toVTT } from './caption-engine.js';
import { manualHighlight } from './highlight-detector.js';
import { categoryLabel, ALL_CATEGORIES } from './event-classifier.js';
import { grabFrame } from './visual-analyzer.js';
import { STEP } from './engagement-scorer.js';

const PW = 540, PH = 960;

export function mount(root) {
  const proj = currentProject();
  root.append(h('div', { class: 'view-head fade-in' }, h('div', {}, h('h1', {}, icon('scissors'), 'Clip Editor'), h('p', { class: 'sub' }, 'Trim, crop to 9:16, edit captions and text. The preview uses the same renderer as export, so what you see is what you get.'))));
  const list = proj ? highlightsOf(proj.id).filter((x) => x.status !== 'rejected').sort((a, b) => a.start - b.start) : [];
  if (!proj || !list.length) { root.append(emptyState('scissors', 'Nothing to edit yet', proj ? 'This project has no highlights. Analyse the recording first.' : 'Select or import a project first.', [h('a', { class: 'btn primary', href: '#/library' }, 'Open Video Library')])); return; }
  let hl = list.find((x) => x.id === state.currentHighlightId) || [...list].sort((a, b) => b.score - a.score)[0];
  state.currentHighlightId = hl.id;
  let video = null, tl = null, segs = [], total = 0, segIdx = 0, playing = false, raf = 0, dead = false, view = 'clip', showSafe = true, loop = true, tab = 'trim';
  const fps = proj.fps || 30;
  const save = debounce(() => saveHighlight(hl, true), 250);

  // ---- layout
  const canvas = h('canvas', { width: PW, height: PH }); const ctx = canvas.getContext('2d');
  const tcode = h('span', { class: 'timecode' }, '0:00.000');
  const playBtn = h('button', { class: 'btn primary icon', 'aria-label': 'Play / pause', onclick: togglePlay }, icon('play'));
  const tlWrap = h('div', { class: 'timeline', tabindex: 0, 'aria-label': 'Timeline' }); const tcv = h('canvas', {}); tlWrap.append(tcv);
  const hs = h('div', { class: 'tl-handle', 'aria-label': 'Clip start' }, h('div', { class: 'grip' })); const he = h('div', { class: 'tl-handle', 'aria-label': 'Clip end' }, h('div', { class: 'grip' })); const ph = h('div', { class: 'tl-play' });
  tlWrap.append(hs, he, ph);
  const panel = h('div', { class: 'card ed-panel' }); const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const picker = h('select', { 'aria-label': 'Highlight', onchange: (e) => switchTo(list.find((x) => x.id === e.target.value)) }, list.map((x) => h('option', { value: x.id, selected: x.id === hl.id }, `${Math.round(x.score)} · ${x.title} · ${fmtTime(x.start)}`)));
  const status = h('div', { class: 'small muted' }, 'Loading video…');

  root.append(h('div', { class: 'editor fade-in' },
    h('div', { class: 'preview-wrap' }, h('div', { class: 'phone' }, canvas), h('div', { class: 'transport' },
      h('button', { class: 'btn icon', 'aria-label': 'Previous frame', 'data-tip': 'Previous frame (←)', onclick: () => stepFrame(-1) }, icon('step-back', 'sm')), playBtn, h('button', { class: 'btn icon', 'aria-label': 'Next frame', 'data-tip': 'Next frame (→)', onclick: () => stepFrame(1) }, icon('step-fwd', 'sm')), tcode), status),
    h('div', { class: 'stack', style: { minWidth: 0 } },
      h('div', { class: 'card pad' }, h('div', { class: 'row' }, h('label', { class: 'field', style: { flex: 1, minWidth: '220px' } }, h('span', { class: 'lbl' }, 'Highlight'), picker),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => { view = view === 'clip' ? 'full' : 'clip'; drawTimeline(); } }, 'Zoom: clip / full'), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (loop = e.target.checked) }), 'Loop'), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (showSafe = e.target.checked) }), 'Safe zones')),
        h('div', { class: 'spacer' }), h('button', { class: 'btn good', onclick: async () => { hl.status = 'approved'; await saveHighlight(hl); toast('Approved — find it in the Export Center.', 'success'); } }, icon('check', 'sm'), 'Approve'), h('a', { class: 'btn primary', href: '#/export', onclick: async () => { hl.status = 'approved'; await saveHighlight(hl); } }, icon('export', 'sm'), 'Export…')),
        h('div', { style: { height: '12px' } }), tlWrap,
        h('div', { class: 'tl-legend', style: { marginTop: '8px' } }, h('span', {}, h('i', { style: { background: '#4da3ff' } }), 'Audio level'), h('span', {}, h('i', { style: { background: '#3ddc97' } }), 'Motion'), h('span', {}, h('i', { style: { background: 'rgba(255,154,46,.35)' } }), 'Highlight regions'), h('span', {}, h('i', { style: { background: '#ff4a36' } }), 'Event markers'), h('span', {}, h('i', { style: { background: '#ff9a2e' } }), 'Selected clip'), h('span', {}, h('i', { style: { background: '#fff' } }), 'Playhead'))),
      panel)));
  const TABS = [['trim', 'Trim'], ['crop', 'Crop'], ['audio', 'Audio'], ['captions', 'Captions'], ['text', 'Text'], ['hook', 'Hook'], ['meta', 'Title & info']];
  const drawTabs = () => { tabsEl.innerHTML = ''; TABS.forEach(([k, l]) => tabsEl.append(h('button', { class: 'tab' + (tab === k ? ' active' : ''), role: 'tab', onclick: () => { tab = k; drawTabs(); drawPanel(); } }, l))); };

  // ---- loading
  async function load() {
    status.textContent = 'Loading video…';
    try {
      const url = await getMediaUrl(proj.id);
      if (!url) { status.innerHTML = ''; status.append(h('div', { class: 'notice warn' }, icon('warn', 'sm'), 'The source video is not available. Re-link it in the Video Library to edit and export this clip.')); }
      else { video = await loadVideo(url, { muted: false }); video.volume = Math.min(1, hl.volume ?? 1); status.textContent = `${video.videoWidth}×${video.videoHeight} source → 1080×1920 export`; }
      tl = await getTimeline(proj.id);
      applyHook(); await seekOut(0);
    } catch (e) { status.textContent = 'Could not load the video: ' + e.message; }
    drawTabs(); drawPanel(); drawTimeline(); frame();
  }
  function applyHook() { segs = segmentsOf(hl); total = outDuration(segs); }
  async function seekOut(t) { if (!video) return; const m = outToSrc(segs, clamp(t, 0, total)); segIdx = m.seg; await seekTo(video, m.src).catch(() => {}); }
  const outNow = () => { if (!video) return 0; let acc = 0; for (let i = 0; i < segIdx; i++) acc += segs[i].end - segs[i].start; const s = segs[segIdx]; return acc + clamp(video.currentTime - s.start, 0, s.end - s.start); };
  function switchTo(x) { stopPlay(); hl = x; state.currentHighlightId = x.id; applyHook(); drawPanel(); drawTimeline(); seekOut(0); }

  // ---- playback
  async function togglePlay() { playing ? stopPlay() : await startPlay(); }
  let playTok = 0;
  async function startPlay() {
    if (!video) return; if (outNow() >= total - 0.05) await seekOut(0); video.volume = Math.min(1, hl.volume ?? 1);
    const tok = ++playTok; playing = true; playBtn.replaceChildren(icon('pause'));
    try { await video.play(); }
    catch (e) {
      if (tok !== playTok || e.name === 'AbortError') return; // interrupted by pause/seek/another click: not an error
      if (e.name === 'NotAllowedError') { try { video.muted = true; await video.play(); toast('Browser blocked sound until you interact with the page — playing muted.', 'warn'); return; } catch (e2) { if (tok !== playTok || e2.name === 'AbortError') return; } }
      playing = false; playBtn.replaceChildren(icon('play')); toast('Playback could not start: ' + e.message, 'warn');
    }
  }
  function stopPlay() { playTok++; playing = false; video?.pause(); playBtn.replaceChildren(icon('play')); }
  let hopping = false;
  async function checkHop() {
    if (!playing || hopping || !video) return; const s = segs[segIdx];
    if (video.currentTime >= s.end - 0.03) {
      hopping = true;
      if (segIdx + 1 < segs.length) { segIdx++; video.pause(); await seekTo(video, segs[segIdx].start).catch(() => {}); if (playing) await video.play().catch(() => {}); }
      else if (loop) { segIdx = 0; await seekTo(video, segs[0].start).catch(() => {}); if (playing) await video.play().catch(() => {}); }
      else { stopPlay(); await seekOut(total); }
      hopping = false;
    }
  }
  async function stepFrame(n) { stopPlay(); if (!video) return; const t = clamp(video.currentTime + n / fps, hl.start, hl.end); const m = srcToOut(segs, t); await seekTo(video, t); const o = outToSrc(segs, m); segIdx = o.seg; }

  // ---- render loop
  function frame() {
    if (dead) return; raf = requestAnimationFrame(frame);
    if (video) { checkHop(); const out = outNow(); renderFrame(ctx, video, hl, video.currentTime, out, PW, PH, { safeGuides: showSafe }); tcode.textContent = `${fmtTime(out, true)} / ${fmtTime(total)}`; movePlayhead(); }
    else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, PW, PH); }
  }

  // ---- timeline
  const range = () => (view === 'full' || !video ? [0, proj.duration || tl?.duration || 1] : [Math.max(0, hl.start - (hl.end - hl.start) * 0.5), Math.min(proj.duration || tl?.duration || 1, hl.end + (hl.end - hl.start) * 0.5)]);
  const tx = (t) => { const [a, b] = range(); return ((t - a) / (b - a)) * tlWrap.clientWidth; };
  const xt = (x) => { const [a, b] = range(); return a + (x / tlWrap.clientWidth) * (b - a); };
  function drawTimeline() {
    const W = tlWrap.clientWidth || 600, H = 120, dpr = window.devicePixelRatio || 1; tcv.width = W * dpr; tcv.height = H * dpr; const c = tcv.getContext('2d'); c.scale(dpr, dpr);
    c.fillStyle = '#0b0c0f'; c.fillRect(0, 0, W, H); const [a, b] = range();
    if (tl?.audio?.available) { c.fillStyle = 'rgba(77,163,255,.7)'; const n = tl.audio.rmsDb.length; for (let x = 0; x < W; x += 2) { const i = clamp(Math.floor(((a + (x / W) * (b - a)) / STEP)), 0, n - 1); const v = clamp((tl.audio.rmsDb[i] + 70) / 60, 0, 1); c.fillRect(x, H * 0.62 - v * H * 0.4, 1.5, v * H * 0.8 * 0.5 + 1); } }
    if (tl?.visual?.available) { c.strokeStyle = '#3ddc97'; c.lineWidth = 1.4; c.beginPath(); const n = tl.visual.motion.length; let mx = 0.001; for (let i = 0; i < n; i++) mx = Math.max(mx, tl.visual.motion[i]); for (let x = 0; x < W; x += 2) { const i = clamp(Math.floor((a + (x / W) * (b - a)) / STEP), 0, n - 1); const v = Math.min(1, tl.visual.motion[i] / (mx * 0.6)); x === 0 ? c.moveTo(x, H - 12 - v * 36) : c.lineTo(x, H - 12 - v * 36); } c.stroke(); }
    for (const x of highlightsOf(proj.id)) { c.fillStyle = x.id === hl.id ? 'rgba(255,154,46,.0)' : 'rgba(255,154,46,.22)'; c.fillRect(tx(x.start), H - 10, tx(x.end) - tx(x.start), 10); c.fillStyle = '#ff4a36'; c.fillRect(tx(x.peak) - 1, 0, 2, 14); }
    c.fillStyle = 'rgba(255,154,46,.16)'; c.fillRect(tx(hl.start), 0, tx(hl.end) - tx(hl.start), H);
    c.fillStyle = '#ff9a2e'; segs.forEach((s) => c.fillRect(tx(s.start), 16, Math.max(2, tx(s.end) - tx(s.start)), s.teaser ? 5 : 3));
    c.fillStyle = '#6c7482'; c.font = '10px sans-serif'; const step = (b - a) / 8; for (let i = 0; i <= 8; i++) { const t = a + i * step; c.fillText(fmtTime(t), clamp(tx(t) + 3, 2, W - 34), H - 14); }
    hs.style.left = tx(hl.start) + 'px'; he.style.left = tx(hl.end) + 'px';
  }
  function movePlayhead() { if (!video) return; ph.style.left = tx(video.currentTime) + 'px'; }
  const ro = new ResizeObserver(() => drawTimeline()); ro.observe(tlWrap);
  tlWrap.addEventListener('pointerdown', (e) => {
    if (e.target === hs || e.target === he || e.target.parentElement === hs || e.target.parentElement === he) return;
    const r = tlWrap.getBoundingClientRect(); const t = xt(e.clientX - r.left); stopPlay();
    const m = srcToOut(segs, clamp(t, hl.start, hl.end)); seekTo(video, t).then(() => { segIdx = outToSrc(segs, m).seg; });
  });
  const drag = (el, which) => el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); el.setPointerCapture(e.pointerId); stopPlay();
    const mv = (ev) => { const r = tlWrap.getBoundingClientRect(); const t = Math.round(xt(ev.clientX - r.left) * 10) / 10; if (which === 's') hl.start = clamp(t, 0, hl.end - 1); else hl.end = clamp(t, hl.start + 1, proj.duration || tl?.duration); drawTimeline(); drawPanel(true); };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); trimmed(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
  drag(hs, 's'); drag(he, 'e');
  async function trimmed() {
    hl.start = +hl.start.toFixed(2); hl.end = +hl.end.toFixed(2);
    if (tl) { const strat = hl.hooks?.find((x) => x.id === hl.selectedHook)?.strategy; const g = generateHooks(hl, tl, state.settings, state.prefs); hl.hooks = g.hooks; hl.selectedHook = (g.hooks.find((x) => x.strategy === strat) || g.hooks[0]).id; }
    applyHook(); save(); drawTimeline(); drawPanel(); await seekOut(0);
  }

  // ---- panels
  const num = (label, get, set, o = {}) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), h('input', { type: 'number', step: o.step ?? 0.01, min: o.min, max: o.max, value: get(), onchange: (e) => set(+e.target.value) }));
  const rng = (label, get, set, o = {}) => { const out = h('b', {}, o.fmt ? o.fmt(get()) : get()); return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label, out), h('input', { type: 'range', min: o.min, max: o.max, step: o.step ?? 1, value: get(), oninput: (e) => { out.textContent = o.fmt ? o.fmt(+e.target.value) : e.target.value; set(+e.target.value); save(); } })); };
  const chk = (label, get, set) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: get(), onchange: (e) => { set(e.target.checked); save(); } }), label);

  function drawPanel(onlyTrimValues) {
    if (onlyTrimValues && tab !== 'trim') return;
    panel.innerHTML = ''; drawTabs(); panel.append(tabsEl);
    const body = h('div', { class: 'stack' }); panel.append(body);
    if (tab === 'trim') {
      const D = proj.duration || tl?.duration || 9999;
      body.append(h('div', { class: 'grid cols-3' }, num('Start (s)', () => hl.start.toFixed(2), (v) => { hl.start = clamp(v, 0, hl.end - 1); trimmed(); }, { min: 0 }), num('End (s)', () => hl.end.toFixed(2), (v) => { hl.end = clamp(v, hl.start + 1, D); trimmed(); }, { min: 0 }), h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Clip duration'), h('b', { style: { fontSize: '22px', fontFamily: 'var(--font-display)' } }, (hl.end - hl.start).toFixed(1) + 's'), h('span', { class: 'help' }, `Output: ${total.toFixed(1)}s ${segs.length > 1 ? '(with hook teaser)' : ''}`))),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => { if (!video) return; hl.start = clamp(+video.currentTime.toFixed(2), 0, hl.end - 1); trimmed(); } }, 'Set start = playhead'), h('button', { class: 'btn sm', onclick: () => { if (!video) return; hl.end = clamp(+video.currentTime.toFixed(2), hl.start + 1, D); trimmed(); } }, 'Set end = playhead'),
          ...[-1, -0.1, 0.1, 1].map((d) => h('button', { class: 'btn sm ghost', onclick: () => { hl.start = clamp(hl.start + d, 0, hl.end - 1); trimmed(); } }, `start ${d > 0 ? '+' : ''}${d}s`)), ...[-1, -0.1, 0.1, 1].map((d) => h('button', { class: 'btn sm ghost', onclick: () => { hl.end = clamp(hl.end + d, hl.start + 1, D); trimmed(); } }, `end ${d > 0 ? '+' : ''}${d}s`))),
        h('div', { class: 'help' }, 'Drag the orange handles on the timeline, type exact times, or step frame-by-frame with the transport buttons (← / → keys). Trimming regenerates the hook options for the new bounds and keeps your chosen strategy.'),
        h('div', { class: 'divider' }), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { if (!tl || !video) return toast('Analysis data or video missing.', 'warn'); const m = manualHighlight(tl, video.currentTime, state.settings, state.prefs, proj.id); Object.assign(m, generateHooks(m, tl, state.settings, state.prefs)); try { m.thumb = await grabFrame(video, video.currentTime); } catch {} await saveHighlight(m); toast('New highlight added at the playhead. Pick it from the Highlight menu (reload view).', 'success', 6000); } }, icon('flag', 'sm'), 'Add a highlight at playhead'), h('span', { class: 'help' }, 'Creates a separate manual clip around the current frame.')));
    }
    if (tab === 'crop') {
      body.append(h('div', { class: 'crop-modes' }, Object.entries(CROP_MODES).map(([k, m]) => h('button', { class: 'crop-mode' + (hl.crop.mode === k ? ' on' : ''), onclick: () => { hl.crop.mode = k; save(); drawPanel(); } }, h('b', {}, m.label), h('small', {}, m.desc)))));
      const fill = hl.crop.mode === 'center' || hl.crop.mode === 'adjustable';
      if (hl.crop.mode === 'follow') {
        const tr = hl.track; const note = h('div', { class: 'help' }, tr ? `Tracked ${tr.xs.length} positions over ${(hl.end - hl.start).toFixed(1)} s (motion seen in ${Math.round(tr.coverage * 100)}% of samples). Re-run after trimming.` : 'Not tracked yet. Press “Track subject” — it also runs automatically on export.');
        const btn = h('button', { class: 'btn sm primary', onclick: async () => { btn.disabled = true; btn.textContent = 'Tracking…'; try { const { ensureTrack } = await import('./track-engine.js'); await ensureTrack(hl, proj, { force: true, onProgress: (p) => (btn.textContent = `Tracking ${Math.round(p * 100)}%`) }); save(); toast('Subject tracking done. Check the preview; switch to Adjustable crop if it picked the wrong thing.', 'success', 6000); } catch (e) { toast('Tracking failed: ' + e.message, 'error', 7000); } drawPanel(); } }, 'Track subject');
        body.append(note, h('div', { class: 'row' }, btn), h('div', { class: 'help' }, 'Follows the main moving region of the frame. It cannot tell a car from a character, and a fast camera pan can mislead it.'));
      }
      if (hl.crop.mode === 'adjustable') body.append(rng('Horizontal position', () => Math.round(hl.crop.x * 100), (v) => (hl.crop.x = v / 100), { min: 0, max: 100, fmt: (v) => v + '%' }), h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => { if (!tl) return; hl.crop.x = +suggestCropX(tl, hl.start, hl.end).toFixed(2); save(); drawPanel(); toast('Crop position set from where motion occurred. This is a static suggestion, not subject tracking.', 'info', 6000); } }, 'Suggest from motion'), h('button', { class: 'btn sm ghost', onclick: () => { hl.crop.x = 0.5; save(); drawPanel(); } }, 'Reset to centre')));
      if (fill) body.append(rng('Zoom', () => Math.round((hl.crop.zoom || 1) * 100), (v) => (hl.crop.zoom = v / 100), { min: 100, max: 180, fmt: (v) => v + '%' }));
      body.append(h('div', { class: 'notice' }, icon('help', 'sm'), 'Footage is never stretched. Crop position is static: ClipForge does not track subjects. The dashed red box is the Reels / Shorts safe zone — keep important action and captions inside it.'));
    }
    if (tab === 'audio') body.append(rng('Clip volume', () => Math.round((hl.volume ?? 1) * 100), (v) => { hl.volume = v / 100; if (video) video.volume = Math.min(1, hl.volume); }, { min: 0, max: 150, fmt: (v) => v + '%' }), h('div', { class: 'help' }, 'Values above 100% boost the exported audio (you hear them capped at 100% in this preview). Audio is only present if the source recording has an audio track.'));
    if (tab === 'captions') captionsPanel(body);
    if (tab === 'text') textPanel(body);
    if (tab === 'hook') {
      body.append(h('div', { class: 'row' }, ...(hl.hooks || []).map((k) => h('button', { class: 'btn' + (hl.selectedHook === k.id ? ' primary' : ''), onclick: async () => { hl.selectedHook = k.id; applyHook(); save(); drawTimeline(); drawPanel(); await seekOut(0); } }, `${k.strategy} · ${k.name} (${k.quality})`))),
        h('div', { class: 'help' }, outDuration(segs) ? `Current output: ${segs.map((s) => `${fmtTime(s.start)}–${fmtTime(s.end)}${s.teaser ? ' (teaser)' : ''}`).join(' → ')}` : ''), h('a', { class: 'btn sm', href: '#/hooks' }, 'Open Hook Intelligence for previews'));
    }
    if (tab === 'meta') {
      body.append(h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Clip title'), h('input', { type: 'text', value: hl.title, oninput: (e) => { hl.title = e.target.value; save(); } })),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Category'), h('select', { onchange: (e) => { hl.category = e.target.value; hl.categoryMethod = 'manual'; save(); } }, ALL_CATEGORIES.map((c) => h('option', { value: c.id, selected: c.id === hl.category }, c.label)))),
        h('div', { class: 'row' }, scoreBadge(hl.score), h('span', { class: 'tag' }, hl.confidence + ' confidence'), h('span', { class: 'small muted' }, hl.reasons[0] || '')),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => previewExport() }, 'Export-size frame preview')));
    }
  }

  function captionsPanel(body) {
    const st = hl.captionStyle;
    body.append(chk('Burn captions into the video', () => hl.captionsEnabled, (v) => (hl.captionsEnabled = v)),
      h('div', { class: 'grid cols-3' },
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Theme'), h('select', { onchange: (e) => { st.theme = e.target.value; save(); } }, Object.entries(THEMES).map(([k, t]) => h('option', { value: k, selected: st.theme === k }, t.name)))),
        rng('Font size', () => st.size, (v) => (st.size = v), { min: 28, max: 120 }), rng('Vertical position', () => Math.round(st.y * 100), (v) => (st.y = v / 100), { min: 15, max: 80, fmt: (v) => v + '%' })),
      h('div', { class: 'row' }, chk('Outline', () => st.outline, (v) => (st.outline = v)), chk('Background box', () => st.box, (v) => (st.box = v)), chk('Word highlight', () => st.highlight, (v) => (st.highlight = v))));
    const rows = h('div', {});
    const draw = () => {
      rows.innerHTML = '';
      if (!hl.captions.length) rows.append(h('div', { class: 'help' }, 'No captions yet. Add one at the playhead, paste a transcript, import SRT/VTT, or use the live transcript. Times below are in source-recording seconds.'));
      hl.captions.sort((a, b) => a.start - b.start).forEach((c) => rows.append(h('div', { class: 'cap-row' },
        h('input', { type: 'number', step: 0.1, value: c.start.toFixed(2), 'aria-label': 'Start', onchange: (e) => { c.start = +e.target.value; save(); } }), h('input', { type: 'number', step: 0.1, value: c.end.toFixed(2), 'aria-label': 'End', onchange: (e) => { c.end = +e.target.value; save(); } }),
        h('input', { type: 'text', value: c.text, 'aria-label': 'Caption text', oninput: (e) => { c.text = e.target.value; save(); } }),
        h('button', { class: 'btn sm icon danger', 'aria-label': 'Delete caption', onclick: () => { hl.captions = hl.captions.filter((x) => x !== c); save(); draw(); } }, icon('x', 'sm')))));
    };
    draw();
    const paste = h('textarea', { placeholder: 'Paste or type what is said in the clip, then “Split across clip”. Timing is spread evenly — adjust rows afterwards.', rows: 3 });
    const clipRel = h('input', { type: 'checkbox', checked: true });
    const imp = h('input', { type: 'file', accept: '.srt,.vtt,text/vtt', class: 'hidden', onchange: async (e) => { const f = e.target.files[0]; if (!f) return; const caps = parseSubtitles(await f.text()); if (!caps.length) return toast('No cues found in that file.', 'error'); caps.forEach((c) => { if (clipRel.checked) { c.start += hl.start; c.end += hl.start; } }); hl.captions.push(...caps.filter((c) => c.end > hl.start && c.start < hl.end)); save(); draw(); toast(`${caps.length} cue(s) imported.`, 'success'); e.target.value = ''; } });
    body.append(h('div', { class: 'divider' }), rows,
      h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => { const t = video?.currentTime ?? hl.start; hl.captions.push(newCaption(t, Math.min(hl.end, t + 2.5), 'New caption')); save(); draw(); } }, icon('edit', 'sm'), 'Add at playhead'),
        h('button', { class: 'btn sm', onclick: () => { hl.captions = []; save(); draw(); } }, 'Clear all'), h('button', { class: 'btn sm', onclick: () => { hl.captions.forEach((c) => { c.start -= 0.1; c.end -= 0.1; }); save(); draw(); } }, 'Shift −0.1 s'), h('button', { class: 'btn sm', onclick: () => { hl.captions.forEach((c) => { c.start += 0.1; c.end += 0.1; }); save(); draw(); } }, 'Shift +0.1 s'),
        h('button', { class: 'btn sm', onclick: () => { const segsTx = (tl?.speech?.segments || []).filter((s) => s.end > hl.start && s.t < hl.end && s.text); if (!segsTx.length) return toast('No live transcript exists for this clip (speech recognition only runs during live capture with a microphone).', 'warn', 7000); hl.captions.push(...segsTx.map((s) => newCaption(Math.max(hl.start, s.t), Math.min(hl.end, s.end + 0.3), s.text))); save(); draw(); toast('Live transcript added (timing is approximate).', 'success'); } }, 'Use live transcript')),
      paste, h('div', { class: 'row' }, h('button', { class: 'btn sm primary', onclick: () => { if (!paste.value.trim()) return; hl.captions.push(...captionsFromText(paste.value, hl.start + 0.5, hl.end - 0.5)); paste.value = ''; save(); draw(); } }, 'Split across clip'),
        h('label', { class: 'btn sm' }, 'Import SRT / VTT', imp), h('label', { class: 'check small' }, clipRel, 'times are relative to clip start'),
        h('button', { class: 'btn sm', onclick: () => downloadBlob(new Blob([toSRT(hl.captions, hl.start)], { type: 'text/plain' }), safeName(hl.title) + '.srt') }, 'Export .srt'), h('button', { class: 'btn sm', onclick: () => downloadBlob(new Blob([toVTT(hl.captions, hl.start)], { type: 'text/vtt' }), safeName(hl.title) + '.vtt') }, 'Export .vtt')),
      h('div', { class: 'help' }, 'Automatic transcription of uploaded files is not possible with the browser’s Web Speech API (it only listens to a live microphone), so uploaded clips use manual / imported captions.'));
  }

  function textPanel(body) {
    const rows = h('div', {});
    const draw = () => {
      rows.innerHTML = '';
      hl.overlays.forEach((ov) => rows.append(h('div', { class: 'ov-card stack' },
        h('div', { class: 'row' }, h('input', { type: 'text', value: ov.text, placeholder: 'Overlay text', style: { flex: 1 }, oninput: (e) => { ov.text = e.target.value; save(); } }), ov.isHook ? h('span', { class: 'tag orange' }, ov.creative ? 'hook · creative suggestion' : 'hook') : null, h('button', { class: 'btn sm icon danger', 'aria-label': 'Delete', onclick: () => { hl.overlays = hl.overlays.filter((x) => x !== ov); save(); draw(); } }, icon('x', 'sm'))),
        h('div', { class: 'grid cols-3' }, rng('X', () => Math.round(ov.x * 100), (v) => (ov.x = v / 100), { min: 5, max: 95, fmt: (v) => v + '%' }), rng('Y', () => Math.round(ov.y * 100), (v) => (ov.y = v / 100), { min: 5, max: 90, fmt: (v) => v + '%' }), rng('Font size', () => ov.size, (v) => (ov.size = v), { min: 28, max: 160 })),
        h('div', { class: 'row' }, h('label', { class: 'row small' }, 'Colour', h('input', { type: 'color', value: ov.color || '#ffffff', oninput: (e) => { ov.color = e.target.value; save(); } })), chk('Outline', () => ov.outline, (v) => (ov.outline = v)), chk('Shadow', () => ov.shadow, (v) => (ov.shadow = v)), chk('Box', () => ov.box, (v) => (ov.box = v)),
          h('label', { class: 'row small' }, 'Show from', h('input', { type: 'number', step: 0.5, min: 0, style: { width: '72px' }, value: ov.outStart ?? '', placeholder: 'start', onchange: (e) => { ov.outStart = e.target.value === '' ? null : +e.target.value; save(); } }), 'to', h('input', { type: 'number', step: 0.5, min: 0, style: { width: '72px' }, value: ov.outEnd ?? '', placeholder: 'end', onchange: (e) => { ov.outEnd = e.target.value === '' ? null : +e.target.value; save(); } }), 's')))));
      if (!hl.overlays.length) rows.append(h('div', { class: 'help' }, 'No text overlays. Times are in output seconds (0 = first frame of the exported clip); leave empty to show for the whole clip.'));
    };
    draw(); body.append(rows, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { hl.overlays.push({ id: uid('ov'), text: 'YOUR TEXT', x: 0.5, y: 0.25, size: 80, color: '#ffffff', outline: true, shadow: true, box: false, outStart: null, outEnd: null }); save(); draw(); } }, icon('edit', 'sm'), 'Add text'),
      ...overlaySuggestions(hl, tl).slice(0, 3).map((s) => h('button', { class: 'chip', 'data-tip': s.note, onclick: () => { hl.overlays.push({ id: uid('ov'), text: s.text, x: 0.5, y: 0.2, size: 80, color: '#ffffff', outline: true, shadow: true, box: false, outStart: 0, outEnd: 3, creative: s.source !== 'speech' }); save(); draw(); } }, '✦ ' + s.text))));
  }

  function previewExport() {
    if (!video) return;
    const w = 1080, hh = 1920; const c = h('canvas', { width: w, height: hh, style: { height: '70vh', maxWidth: '100%', borderRadius: '10px', background: '#000' } });
    renderFrame(c.getContext('2d'), video, hl, video.currentTime, outNow(), w, hh, { safeGuides: false });
    modal({ title: 'Export preview (1080×1920 frame at playhead)', body: h('div', { style: { display: 'grid', placeItems: 'center' } }, c) });
  }

  const onKey = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); } else if (e.code === 'ArrowRight') { e.preventDefault(); stepFrame(e.shiftKey ? fps : 1); } else if (e.code === 'ArrowLeft') { e.preventDefault(); stepFrame(e.shiftKey ? -fps : -1); }
  };
  document.addEventListener('keydown', onKey);
  load();
  return () => { dead = true; cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey); ro.disconnect(); if (video) disposeVideo(video); saveHighlight(hl, true); };
}
