// Live Clipper: authorised screen capture via getDisplayMedia + MediaRecorder, rolling buffer, live analysis, flagged moments.
import { h, icon, fmtBytes, fmtTime, toast, confirmDialog, emptyState, loadVideo, disposeVideo, clamp, uid, downloadBlob } from './utils.js';
import { state, newProject, attachMedia, saveProject, saveTimeline, setCurrentProject, setProcessing, endProcessing, addHistory, setCurrentProject as setCur, saveHighlights, highlightsOf } from './state.js';
import { LiveAudioAnalyzer, AUDIO_STEP } from './audio-analyzer.js';
import { VisualExtractor, makeSampler, VIS_KEYS } from './visual-analyzer.js';
import { AUDIO_KEYS } from './dsp.js';
import { SpeechMonitor, speechSupported } from './speech-analyzer.js';
import { detectHighlights, manualHighlight } from './highlight-detector.js';
import { finishDetection } from './analyze.js';
import { rightsNotice, RIGHTS_TEXT } from './video-upload.js';
import { generateHooks } from './hook-intelligence.js';
import { grabFrame } from './visual-analyzer.js';
import { STEP } from './engagement-scorer.js';

/** Bounded rolling buffer of MediaRecorder chunks. Header chunk and chunks of flagged moments are never evicted. */
export class RollingBuffer {
  constructor({ maxBytes = 1.5e9, preRoll = 10, postRoll = 10, margin = 2 } = {}) {
    Object.assign(this, { maxBytes, preRoll, postRoll, margin }); this.chunks = []; this.bytes = 0; this.windows = []; this.gaps = []; this.overflow = false;
  }
  push(blob, t0, t1) {
    const c = { blob, size: blob.size, t0, t1, header: this.chunks.length === 0, prot: false };
    this.chunks.push(c); this.bytes += c.size; this._mark(c); this.evict(); return c;
  }
  _mark(c) { if (this.windows.some((w) => c.t1 > w.from && c.t0 < w.to)) c.prot = true; }
  /** Protect [from,to] (clip bounds) plus pre/post roll and a safety margin; also covers chunks that have not arrived yet. */
  protect(from, to) {
    const w = { from: from - this.margin, to: to + this.margin }; this.windows.push(w);
    this.chunks.forEach((c) => this._mark(c));
  }
  evict() {
    while (this.bytes > this.maxBytes) {
      const i = this.chunks.findIndex((c) => !c.prot && !c.header);
      if (i < 0) { this.overflow = true; return; }
      const [c] = this.chunks.splice(i, 1); this.bytes -= c.size; this.gaps.push({ from: c.t0, to: c.t1 });
    }
  }
  stats() { return { count: this.chunks.length, bytes: this.bytes, protectedCount: this.chunks.filter((c) => c.prot).length, evicted: this.gaps.length, overflow: this.overflow }; }
  assemble(type) { return new Blob(this.chunks.map((c) => c.blob), { type }); }
}

const QUALITY = { '720p30': { w: 1280, h: 720, fps: 30 }, '1080p30': { w: 1920, h: 1080, fps: 30 }, '1080p60': { w: 1920, h: 1080, fps: 60 } };
function pickMime() {
  const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=h264,opus', 'video/webm', 'video/mp4'];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

let session = null; // survives view changes so capture continues while you browse

export function mount(root) {
  const supported = !!(navigator.mediaDevices?.getDisplayMedia && window.MediaRecorder);
  const rights = h('input', { type: 'checkbox', onchange: sync });
  const startBtn = h('button', { class: 'btn primary', onclick: start }, icon('rec', 'sm'), 'Start capture');
  const pauseBtn = h('button', { class: 'btn', onclick: togglePause }, icon('pause', 'sm'), 'Pause');
  const stopBtn = h('button', { class: 'btn danger', onclick: () => stop(false) }, icon('stop', 'sm'), 'Stop & analyse');
  const flagBtn = h('button', { class: 'btn', 'data-tip': 'Manually mark the last moment (protects it in the buffer and adds a highlight)', onclick: markNow }, icon('flag', 'sm'), 'Mark moment');
  const video = h('video', { muted: true, playsinline: true, autoplay: true });
  const recTag = h('span', { class: 'tag red hidden' }, h('span', { class: 'rec-dot' }), h('span', { id: 'rec-time' }, '00:00'));
  const audTag = h('span', { class: 'tag hidden' }, 'Audio');
  const stage = h('div', { class: 'live-stage' }, video, h('div', { class: 'overlay' }, recTag, audTag), h('div', { id: 'stage-empty', class: 'muted', style: { position: 'absolute', textAlign: 'center', padding: '20px' } }, 'No capture running. Choose a tab, window or screen you are authorised to record.'));
  const vu = h('div', { class: 'vu' }, h('i')); const bufBar = h('div', { class: 'buffer-bar' }); const bufStats = h('div', { class: 'small muted' }); const flagList = h('div', { class: 'list' });
  const warnBox = h('div', { class: 'stack' }); const speechBox = h('div', { class: 'small muted' }, 'Speech detection idle.');
  const sttToggle = h('input', { type: 'checkbox', checked: state.settings.speechEnabled && speechSupported(), disabled: !speechSupported() });
  const quality = h('select', {}, Object.keys(QUALITY).map((k) => h('option', { value: k, selected: state.settings.captureQuality === k }, k)));
  const audioChk = h('input', { type: 'checkbox', checked: state.settings.liveAudio });

  const streamUrl = h('input', { type: 'url', placeholder: 'https://www.youtube.com/watch?v=…', style: { flex: '1' } });
  const openStream = () => {
    let u; try { u = new URL(streamUrl.value.trim()); } catch { toast('Enter a full link starting with https://', 'error'); return; }
    if (!/^https?:$/.test(u.protocol)) { toast('Only http(s) links can be opened.', 'error'); return; }
    window.open(u.href, '_blank', 'noopener,noreferrer');
    toast('Opened in a new tab. Come back here, press Start capture, and pick that tab with “Share tab audio”.', 'info', 9000);
  };
  root.append(...[
    h('div', { class: 'view-head fade-in' }, h('div', {}, h('h1', {}, icon('live'), 'Live Clipper'), h('p', { class: 'sub' }, 'Share the tab with your live stream once. ClipForge watches it live and cuts a clip for each detected moment a few seconds after it ends. No need to press Stop. Only record streams you own or have permission to clip.'))),
    !supported ? h('div', { class: 'notice err' }, icon('warn'), 'Screen capture (getDisplayMedia) or MediaRecorder is not available. Use a current desktop Chrome, Edge or Firefox over HTTPS (or localhost). Mobile browsers generally cannot capture screens.') : null,
    h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,2fr) minmax(280px,1fr)' } },
      h('div', { class: 'stack' }, stage, h('div', { class: 'row' }, startBtn, pauseBtn, stopBtn, flagBtn, h('span', { class: 'spacer' }), h('span', { class: 'small muted', id: 'cap-status' }, 'Idle')),
        h('div', { class: 'card pad stack' }, h('div', { class: 'card-head' }, h('h3', {}, 'Rolling buffer')), bufBar, bufStats, h('div', { class: 'help' }, 'Orange = chunks protected because they belong to a flagged moment (± pre/post-roll). Blue = header chunk. Old unprotected chunks are evicted only when the buffer cap is exceeded.')),
        h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Flagged moments (live)')), flagList)),
      h('div', { class: 'stack' },
        h('div', { class: 'card pad stack' }, h('div', { class: 'card-head' }, h('h3', {}, 'Stream link (optional)')),
          h('div', { class: 'help' }, 'ClipForge cannot download a stream from a link. Open it in its own tab, then choose that tab (with “Share tab audio”) when you press Start capture.'),
          h('div', { class: 'row' }, streamUrl, h('button', { class: 'btn', onclick: openStream }, 'Open in new tab'))),
        h('div', { class: 'card pad stack' }, h('div', { class: 'card-head' }, h('h3', {}, 'Before you start')),
          h('label', { class: 'check' }, rights, h('span', {}, RIGHTS_TEXT)), rightsNotice(),
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Capture quality'), quality),
          h('label', { class: 'check' }, audioChk, h('span', {}, 'Request audio ', h('span', { class: 'help' }, '(tick “Share audio” in the browser picker)'))),
          h('label', { class: 'check' }, sttToggle, h('span', {}, 'Detect spoken reactions (Web Speech API, uses your microphone) ', !speechSupported() ? h('span', { class: 'tag red' }, 'not supported here') : null)),
          h('div', { class: 'help' }, `Pre-roll ${state.settings.preRoll}s · post-roll ${state.settings.postRoll}s · buffer cap ${state.settings.bufferMaxMB} MB (change in Settings).`), warnBox),
        h('div', { class: 'card pad stack' }, h('div', { class: 'card-head' }, h('h3', {}, 'Signals')), h('div', { class: 'small muted' }, 'Audio level'), vu, speechBox)))].filter(Boolean));
  sync();

  // reattach to a running session
  if (session) attach();
  function sync() { startBtn.disabled = !supported || !rights.checked || !!session; pauseBtn.disabled = stopBtn.disabled = flagBtn.disabled = !session; }
  const setStatus = (t) => { const e = document.getElementById('cap-status'); if (e) e.textContent = t; };
  const warn = (msg, cls = 'warn') => { warnBox.append(h('div', { class: 'notice ' + cls + ' small' }, icon('warn', 'sm'), msg)); };

  async function start() {
    if (session) return; warnBox.innerHTML = '';
    const q = QUALITY[quality.value];
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: q.fps }, width: { ideal: q.w }, height: { ideal: q.h } }, audio: audioChk.checked ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false });
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Screen capture was cancelled or blocked. Click Start capture again and choose a source.' : 'Could not start capture: ' + e.message, 'error', 8000); return;
    }
    const mime = pickMime();
    let rec; try { rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: q.h >= 1080 ? 6e6 : 3.5e6 }); } catch (e) { stream.getTracks().forEach((t) => t.stop()); toast('MediaRecorder could not start: ' + e.message, 'error', 8000); return; }
    const S = session = {
      id: uid('cap'), stream, rec, mime: rec.mimeType || mime || 'video/webm', t0: performance.now(), paused: false, pausedAt: 0, pausedTotal: 0, lastChunkEnd: 0,
      buffer: new RollingBuffer({ maxBytes: state.settings.bufferMaxMB * 1048576, preRoll: state.settings.preRoll, postRoll: state.settings.postRoll }),
      audio: { feats: Object.fromEntries(AUDIO_KEYS.map((k) => [k, []])), analyzer: null, available: false }, visual: { feats: Object.fromEntries(VIS_KEYS.map((k) => [k, []])), ex: new VisualExtractor(), grab: makeSampler() },
      speech: { segs: [], mon: null }, flagged: [], manual: [], lastDetect: 0, hasAudio: stream.getAudioTracks().length > 0, dims: (() => { const st = stream.getVideoTracks()[0]?.getSettings?.() || {}; return { w: st.width || q.w, h: st.height || q.h }; })(), ended: false, name: 'Live capture ' + new Date().toLocaleString(), q, level: 0,
    };
    S.elapsed = () => ((S.paused ? S.pausedAt : performance.now()) - S.t0 - S.pausedTotal) / 1000;
    rec.ondataavailable = (e) => { if (!e.data?.size) return; const t = S.elapsed(); S.buffer.push(e.data, S.lastChunkEnd, t); S.lastChunkEnd = t; };
    rec.onerror = (e) => { toast('Recorder error: ' + (e.error?.message || 'unknown'), 'error'); stop(true); };
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (session === S) { toast('Capture source ended (sharing stopped). Finalising your recording…', 'warn'); stop(true); } });
    rec.start(1000);

    // analysis hooks
    S.audio.analyzer = new LiveAudioAnalyzer(stream, { onWindow: (f, i) => { AUDIO_KEYS.forEach((k) => (S.audio.feats[k][i] = f[k])); }, onLevel: (l) => (S.level = l) });
    S.audio.available = S.hasAudio ? await S.audio.analyzer.start().catch(() => false) : false;
    if (!S.hasAudio) setTimeout(() => warn('No audio was captured. Browsers only share audio when you pick a TAB (tick “Also share tab audio”) or, on Windows, an entire screen with “Share system audio”. Window capture usually has no audio. Highlights will use visual signals only.'), 0);
    S.visual.timer = setInterval(() => sampleVisual(S), STEP * 1000);
    if (sttToggle.checked && speechSupported()) {
      S.speech.mon = new SpeechMonitor({ lang: state.settings.speechLang, settings: () => state.settings, getTime: () => S.elapsed(),
        onResult: (r) => { if (S.paused) return; if (r.final) { const dur = Math.max(1.2, r.text.split(/\s+/).length * 0.32); S.speech.segs.push({ t: Math.max(0, r.t - dur), end: r.t, text: r.text, hits: r.hits }); } if (r.hits.length) { sttStatus(`Heard: “${r.text}”`); } else if (r.final) sttStatus(`Transcript: “${r.text}”`); },
        onError: (m) => { sttStatus(m); warn(m); }, onState: (s) => sttStatus(s === 'listening' ? 'Listening for configured reactions…' : 'Speech detection stopped.') });
      S.speech.mon.start();
    } else sttStatus(speechSupported() ? 'Speech detection is off.' : 'Speech recognition is not supported in this browser — using voice-band loudness as a reaction proxy.');
    S.ui = setInterval(() => ui(S), 250);
    S.clipTimer = setInterval(() => clipPump(S), 2000);
    setProcessing({ active: true, label: 'Live capture running', pct: 0, cancel: null, error: null });
    video.srcObject = stream; video.play().catch(() => {});
    addHistory('capture', 'started', 'Live capture started', null);
    attach(); sync();
  }
  const sttStatus = (m) => { speechBox.textContent = m; };

  function sampleVisual(S) {
    if (S.paused || S.ended || video.readyState < 2) return;
    const i = Math.floor(S.elapsed() / STEP); const f = S.visual.ex.push(S.visual.grab(video));
    VIS_KEYS.forEach((k) => { const a = S.visual.feats[k]; while (a.length < i) a.push(a.length ? a[a.length - 1] : 0); a[i] = f[k]; });
    if (S.elapsed() - S.lastDetect > Math.max(4, S.elapsed() / 300)) { S.lastDetect = S.elapsed(); liveDetect(S); }
  }
  function snapshotTL(S) {
    const n = Math.max(S.visual.feats.motion.length, S.audio.feats.rmsDb.length);
    const fill = (arr, n_, d = 0) => { const o = new Float32Array(n_); for (let i = 0; i < n_; i++) o[i] = arr[i] ?? d; return o; };
    const tl = { projectId: 'live', step: STEP, duration: n * STEP, speech: { available: S.speech.segs.length > 0 || !!S.speech.mon, segments: S.speech.segs.slice() } };
    tl.audio = S.audio.available ? { available: true, method: 'live', ...Object.fromEntries(AUDIO_KEYS.map((k) => [k, fill(S.audio.feats[k], n, k === 'rmsDb' || k === 'peakDb' ? -120 : 0)])) } : { available: false, reason: S.hasAudio ? 'Audio analyser failed to start.' : 'No audio track was captured.' };
    tl.visual = { available: true, interval: STEP, ...Object.fromEntries(VIS_KEYS.map((k) => [k, fill(S.visual.feats[k], n, k === 'motionX' ? 0.5 : 0)])) };
    return tl;
  }
  function liveDetect(S) {
    try {
      const tl = snapshotTL(S); if (tl.duration < 12) return;
      const res = detectHighlights(tl, { ...state.settings, maxCandidates: 50 }, state.prefs, { projectId: 'live', minAgeSec: 2 });
      for (const hl of res.highlights) {
        if (S.flagged.some((f) => Math.abs(f.eventStart - hl.eventStart) < 6)) continue;
        S.flagged.push({ eventStart: hl.eventStart, start: hl.start, end: hl.end, score: hl.score, category: hl.category, why: hl.reasons[0] || '', hl, clip: 'pending' });
        S.buffer.protect(hl.start, hl.end); renderFlags(S);
      }
    } catch (e) { console.warn('live detect', e); }
  }
  function markNow() {
    const S = session; if (!S) return; const t = S.elapsed(); const from = Math.max(0, t - state.settings.preRoll);
    S.manual.push(t); S.buffer.protect(from, t + state.settings.postRoll);
    S.flagged.push({ eventStart: t, start: from, end: t + state.settings.postRoll, score: null, category: 'manual', why: 'Marked manually', manual: true, clip: 'pending' }); renderFlags(S); toast('Moment marked and protected in the buffer.', 'success', 2000);
  }
  /** Cut finished moments out of the rolling buffer into their own clip projects while the capture keeps running. */
  async function clipPump(S) {
    if (S.cutting || S.ended || S.paused) return;
    const f = S.flagged.find((x) => x.clip === 'pending' && S.elapsed() >= x.end + 3);
    if (!f) return;
    S.cutting = true; f.clip = 'cutting'; renderFlags(S);
    try { await cutClip(S, f); f.clip = 'ready'; toast(`Clip ready at ${fmtTime(f.eventStart)}${f.score != null ? ' · score ' + f.score : ''}. Find it in the list or in AI Highlights.`, 'success', 5000); }
    catch (e) { console.warn('clip cut', e); f.clip = 'failed'; f.err = e.message; }
    finally { S.cutting = false; renderFlags(S); }
  }
  async function cutClip(S, f) {
    const { getMediaUrl, getTimeline } = await import('./state.js');
    const cs = Math.max(0, f.start - 2), ce = Math.min(S.elapsed(), f.end + 2);
    const head = S.buffer.chunks[0]; if (!head) throw new Error('buffer is empty');
    const body = S.buffer.chunks.filter((c) => !c.header && c.t1 > cs && c.t0 < ce);
    if (!body.length) throw new Error('that part of the recording is no longer in the buffer');
    const blob = new Blob([head.blob, ...body.map((c) => c.blob)], { type: S.mime });
    const ext = S.mime.includes('mp4') ? 'mp4' : 'webm';
    const file = new File([blob], `live-clip-${Math.round(f.eventStart)}s.${ext}`, { type: S.mime });
    const tl = snapshotTL(S);
    const p = newProject({ name: `Live clip ${fmtTime(f.eventStart)} · ${new Date().toLocaleTimeString()}`, source: 'live', liveClip: true, filename: file.name, size: file.size, mime: S.mime, duration: ce, width: S.dims.w, height: S.dims.h, fps: S.q.fps, hasAudio: S.audio.available, rights: true, rightsAt: Date.now(), status: 'analyzed', stats: { highlights: 1 }, analysisInfo: { audio: tl.audio.available ? { available: true, method: 'live' } : { available: false, reason: tl.audio.reason }, visual: { available: true, interval: STEP }, speech: tl.speech.available ? { available: true, segments: tl.speech.segments.length } : { available: false, reason: 'Speech detection was off or unsupported.' } } });
    await attachMedia(p, file); tl.projectId = p.id; await saveTimeline(tl);
    let hl;
    if (f.hl) { hl = { ...f.hl, id: uid('hl'), projectId: p.id, createdAt: Date.now() }; } else { hl = manualHighlight(tl, f.eventStart, state.settings, state.prefs, p.id); }
    Object.assign(hl, generateHooks(hl, tl, state.settings, state.prefs));
    let v = null;
    try { v = await loadVideo(await getMediaUrl(p.id)); hl.thumb = await grabFrame(v, clamp(hl.peak, cs, ce - 0.2)); p.thumb = hl.thumb; f.thumb = hl.thumb; } catch { hl.thumb = null; } finally { if (v) disposeVideo(v); }
    await saveHighlights([hl]); p.analyzedAt = Date.now(); await saveProject(p);
    f.projectId = p.id; f.hlId = hl.id; await addHistory('capture', 'success', `Live clip cut at ${fmtTime(f.eventStart)}`, p);
  }
  function renderFlags(S) {
    flagList.innerHTML = '';
    if (!S.flagged.length) return flagList.append(h('div', { class: 'help' }, 'Nothing flagged yet. Moments appear here as the engine detects them (a few seconds after they happen).'));
    [...S.flagged].reverse().forEach((f) => {
      const st = f.clip === 'ready' ? h('span', { class: 'row' }, h('a', { class: 'btn sm primary', href: '#/editor', onclick: () => { state.currentProjectId = f.projectId; state.currentHighlightId = f.hlId; } }, 'Edit'), h('a', { class: 'btn sm', href: '#/highlights', onclick: () => { state.currentProjectId = f.projectId; } }, 'Review'))
        : f.clip === 'failed' ? h('span', { class: 'tag red', 'data-tip': f.err || '' }, 'clip failed')
        : h('span', { class: 'tag' }, f.clip === 'cutting' ? 'cutting clip…' : 'clip when moment ends');
      flagList.append(h('div', { class: 'list-item' }, f.thumb ? h('div', { class: 'thumb', style: { backgroundImage: `url(${f.thumb})` } }) : null, h('span', { class: 'tag ' + (f.score >= 80 ? 'red' : 'orange') }, f.score != null ? f.score : 'manual'), h('div', { class: 'li-main' }, h('div', { class: 't' }, `${fmtTime(f.eventStart)} · ${f.category}`), h('div', { class: 'm' }, f.why)), st));
    });
  }
  function ui(S) {
    const e = document.getElementById('rec-time'); if (e) e.textContent = fmtTime(S.elapsed());
    vu.firstChild.style.width = Math.min(100, S.level * 260) + '%';
    const st = S.buffer.stats(); bufStats.textContent = `${st.count} chunks · ${fmtBytes(st.bytes)} of ${fmtBytes(S.buffer.maxBytes)} cap · ${st.protectedCount} protected · ${st.evicted} evicted${st.overflow ? ' · ⚠ cap reached (protected chunks kept)' : ''}`;
    bufBar.innerHTML = ''; const last = S.buffer.chunks.slice(-80); last.forEach((c) => bufBar.append(h('i', { class: c.header ? 'head' : c.prot ? 'prot' : '' })));
    setProcessing({ label: (S.paused ? 'Capture paused ' : 'Live capture ') + fmtTime(S.elapsed()), pct: 0 });
  }
  function attach() {
    const S = session; if (!S) return;
    video.srcObject = S.stream; video.play().catch(() => {}); document.getElementById('stage-empty')?.classList.add('hidden');
    recTag.classList.remove('hidden'); audTag.classList.remove('hidden'); audTag.textContent = S.audio.available ? '🔊 Audio on' : '🔇 No audio'; audTag.className = 'tag ' + (S.audio.available ? 'green' : 'orange');
    setStatus(S.paused ? 'Paused' : 'Recording'); renderFlags(S); sync();
    if (S.paused) pauseBtn.replaceChildren(icon('play', 'sm'), 'Resume');
  }
  function togglePause() {
    const S = session; if (!S) return;
    if (!S.paused) { S.rec.pause(); S.paused = true; S.pausedAt = performance.now(); S.audio.analyzer && (S.audio.analyzer.paused = true); pauseBtn.replaceChildren(icon('play', 'sm'), 'Resume'); setStatus('Paused'); }
    else { S.rec.resume(); S.pausedTotal += performance.now() - S.pausedAt; S.paused = false; S.audio.analyzer && (S.audio.analyzer.paused = false); pauseBtn.replaceChildren(icon('pause', 'sm'), 'Pause'); setStatus('Recording'); }
  }

  async function stop(auto) {
    const S = session; if (!S || S.ended) return; S.ended = true;
    if (!auto && !(await confirmDialog('Stop capture?', 'The full recording will be saved and analysed. Clips already cut during the capture are kept.', { okText: 'Stop & analyse' }))) { S.ended = false; return; }
    clearInterval(S.visual.timer); clearInterval(S.ui); clearInterval(S.clipTimer); S.speech.mon?.stop(); S.audio.analyzer?.stop();
    if (S.paused) { S.pausedTotal += performance.now() - S.pausedAt; S.paused = false; }
    const finalT = S.elapsed();
    await new Promise((res) => { if (S.rec.state === 'inactive') return res(); S.rec.onstop = res; try { S.rec.stop(); } catch { res(); } });
    S.stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; session = null;
    recTag.classList.add('hidden'); audTag.classList.add('hidden'); document.getElementById('stage-empty')?.classList.remove('hidden'); setStatus('Finalising…'); sync();
    try { await finalise(S, finalT); } catch (e) {
      console.error(e); endProcessing('Capture failed', e.message); setStatus('Idle');
      // Recovery: never lose a long capture because analysis failed.
      if (S.buffer.chunks.length && await confirmDialog('Could not finalise the recording', `${e.message}\n\nThe raw recording (${fmtBytes(S.buffer.bytes)}) is still in memory. Download it now so it is not lost?`, { okText: 'Download recording' })) downloadBlob(S.buffer.assemble(S.mime), 'clipforge-recovered-capture.' + (S.mime.includes('mp4') ? 'mp4' : 'webm'));
    }
  }

  async function finalise(S, dur) {
    if (!S.buffer.chunks.length || dur < 2) { endProcessing('Idle'); setStatus('Idle'); return toast('The recording was too short to keep.', 'warn'); }
    setProcessing({ active: true, label: 'Finalising recording…', pct: 5, cancel: null });
    const blob = S.buffer.assemble(S.mime); const st = S.buffer.stats();
    const ext = S.mime.includes('mp4') ? 'mp4' : 'webm';
    const file = new File([blob], `live-capture-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`, { type: S.mime });
    const p = newProject({ name: S.name, source: 'live', filename: file.name, size: file.size, mime: S.mime, duration: dur, width: S.dims.w, height: S.dims.h, fps: S.q.fps, hasAudio: S.audio.available, rights: true, rightsAt: Date.now(), status: 'analyzing', stats: { highlights: 0 }, partial: st.evicted > 0 });
    await attachMedia(p, file); setCur(p.id);
    const tl = snapshotTL(S); tl.projectId = p.id; tl.duration = Math.min(dur, tl.duration || dur);
    if (!S.speech.mon) tl.speech = { available: false, segments: [], reason: speechSupported() ? 'Speech detection was off for this capture.' : 'Speech recognition is not supported in this browser.' };
    await saveTimeline(tl);
    const { url } = await getUrl(p); let video_ = null;
    try {
      video_ = await loadVideo(url);
      p.thumb = await grabFrame(video_, Math.min(dur * 0.1, dur - 0.2)).catch(() => null);
      setProcessing({ label: 'Detecting highlights…', pct: 40 });
      const res = await finishDetection(p, tl, video_, null, null, (pr, l) => setProcessing({ label: l, pct: 40 + pr * 50 }));
      // add manual marks
      if (S.manual.length) { const list = S.manual.map((t) => manualHighlight(tl, t, state.settings, state.prefs, p.id)); for (const hl of list) { Object.assign(hl, generateHooks(hl, tl, state.settings, state.prefs)); try { hl.thumb = await grabFrame(video_, clamp(hl.peak, 0, dur - 0.2)); } catch {} } await saveHighlights(list); }
    } finally { if (video_) disposeVideo(video_); }
    p.status = 'analyzed'; p.analyzedAt = Date.now(); p.stats = { highlights: highlightsOf(p.id).length };
    p.analysisInfo = { audio: tl.audio.available ? { available: true, method: 'live' } : { available: false, reason: tl.audio.reason }, visual: { available: true, interval: STEP }, speech: tl.speech.available ? { available: true, segments: tl.speech.segments.length } : { available: false, reason: tl.speech.reason } };
    await saveProject(p); endProcessing('Capture analysed');
    await addHistory('capture', 'success', `Captured ${fmtTime(dur)} · ${p.stats.highlights} highlight(s)`, p);
    setStatus('Idle'); toast(`Capture saved and analysed: ${p.stats.highlights} highlight(s).${st.evicted ? ' Note: some old chunks were evicted from the buffer.' : ''}`, 'success', 7000);
    if (st.evicted) toast('Buffer eviction removed old unflagged footage; playback of this recording may have gaps.', 'warn', 9000);
    location.hash = '#/highlights';
  }
  async function getUrl(p) { const { getMediaUrl } = await import('./state.js'); return { url: await getMediaUrl(p.id) }; }

  return () => { /* keep capture session alive when navigating away */ };
}
export const isCapturing = () => !!session;
