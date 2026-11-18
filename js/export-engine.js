// Export engine: canvas compositor → MediaRecorder (MP4 natively where supported, otherwise WebM),
// optional FFmpeg.wasm transcode to H.264/AAC MP4, strict output verification, cover frames, metadata templates, ZIP.
import { ensureTrack } from './track-engine.js';
import { getMediaUrl } from './state.js';
import { loadVideo, disposeVideo, seekTo, clamp, bus, fmtTime, safeName } from './utils.js';
import { renderFrame } from './compositor.js';
import { segmentsOf, outDuration } from './hook-intelligence.js';
import { categoryLabel } from './event-classifier.js';

// ================= FFmpeg.wasm (single-threaded, no SharedArrayBuffer) =================
const CORE_VER = '0.12.6';
const CDNS = [`https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VER}/dist/esm`, `https://unpkg.com/@ffmpeg/core@${CORE_VER}/dist/esm`];
let ff = null, loading = null; const ffs = { state: 'idle', message: '', codecs: null, progress: 0 };
const setFF = (p) => { Object.assign(ffs, p); bus.emit('ffmpeg', { ...ffs }); };
export const ffmpegStatus = () => ({ ...ffs });

async function toBlobURL(url, type, onProgress) {
  const res = await fetch(url, { mode: 'cors' }); if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = +res.headers.get('content-length') || 0; const reader = res.body?.getReader();
  if (!reader) return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
  const parts = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; if (total) onProgress?.(got / total); }
  return URL.createObjectURL(new Blob(parts, { type }));
}

export function initFFmpeg() {
  if (ffs.state === 'ready' && ff) return Promise.resolve(ff);
  if (loading) return loading;
  loading = (async () => {
    setFF({ state: 'loading', message: 'Downloading FFmpeg core (~31 MB)…', progress: 0 });
    let lastErr;
    try {
      const { FFmpeg } = await import('../vendor/ffmpeg/index.js');
      const inst = new FFmpeg(); const logs = []; inst.on('log', ({ message }) => { logs.push(message); if (logs.length > 400) logs.shift(); });
      for (const base of CDNS) {
        try {
          const coreURL = await toBlobURL(base + '/ffmpeg-core.js', 'text/javascript');
          const wasmURL = await toBlobURL(base + '/ffmpeg-core.wasm', 'application/wasm', (p) => setFF({ progress: p, message: `Downloading FFmpeg core… ${Math.round(p * 100)}%` }));
          setFF({ message: 'Starting FFmpeg…' }); await inst.load({ coreURL, wasmURL }); lastErr = null; break;
        } catch (e) { lastErr = e; }
      }
      if (lastErr) throw lastErr;
      logs.length = 0; await inst.exec(['-hide_banner', '-encoders']);
      const text = logs.join('\n'); const codecs = { x264: /libx264/.test(text), aac: /\baac\b/.test(text), vp9: /libvpx-vp9/.test(text) };
      if (!codecs.x264 || !codecs.aac) { setFF({ state: 'failed', message: 'This FFmpeg build lacks libx264 and/or AAC, so MP4 transcoding is unavailable.', codecs }); throw new Error('FFmpeg build lacks H.264/AAC encoders'); }
      ff = inst; setFF({ state: 'ready', message: 'FFmpeg.wasm ready (single-thread)', codecs, progress: 1 }); return inst;
    } catch (e) { ff = null; setFF({ state: 'failed', message: 'Could not load FFmpeg.wasm: ' + e.message }); throw e; }
    finally { loading = null; }
  })();
  return loading;
}
export function resetFFmpeg() { try { ff?.terminate(); } catch {} ff = null; setFF({ state: 'idle', message: '', progress: 0 }); }

export async function transcodeToMp4(blob, { w, h, onProgress, signal }) {
  const inst = await initFFmpeg();
  const onP = ({ progress }) => onProgress?.(clamp(progress, 0, 1)); inst.on('progress', onP);
  const abort = () => resetFFmpeg(); signal?.addEventListener('abort', abort, { once: true });
  try {
    await inst.writeFile('in.webm', new Uint8Array(await blob.arrayBuffer()));
    const code = await inst.exec(['-i', 'in.webm', '-vf', `scale=${w}:${h}:flags=bicubic:out_range=tv,format=yuv420p`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-r', '30', '-color_range', 'tv', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', 'out.mp4']);
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (code !== 0) throw new Error('FFmpeg exited with code ' + code);
    const data = await inst.readFile('out.mp4'); if (!data?.length) throw new Error('FFmpeg produced an empty file');
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally { signal?.removeEventListener('abort', abort); try { inst.off?.('progress', onP); await inst.deleteFile('in.webm'); await inst.deleteFile('out.mp4'); } catch {} }
}

// ================= Rendering =================
export function nativeMp4Mime() {
  if (!window.MediaRecorder) return null;
  // Only explicit H.264 + AAC counts. A bare 'video/mp4' may silently record VP9/Opus inside an MP4 container, which Instagram rejects.
  return ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a'].find((m) => MediaRecorder.isTypeSupported(m)) || null;
}
const webmMime = () => ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || null;
export function exportCapabilities() {
  return { recorder: !!window.MediaRecorder && !!HTMLCanvasElement.prototype.captureStream, nativeMp4: !!nativeMp4Mime(), webm: !!webmMime(), ffmpeg: ffmpegStatus().state };
}

async function renderClip(hl, proj, { w, h: hh, fps, format, bitrate }, { onProgress, signal }) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('This browser cannot record canvas video (MediaRecorder / captureStream missing). Use a current Chrome, Edge or Firefox.');
  const url = await getMediaUrl(proj.id); if (!url) throw new Error('The source video is not available. Re-link it in the Video Library.');
  const video = await loadVideo(url, { muted: false });
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = hh; const ctx = canvas.getContext('2d', { alpha: false });
  const segs = segmentsOf(hl); const total = outDuration(segs); const warnings = [];
  let ac = null, mime = null, native = false;
  const m4 = format === 'mp4' ? nativeMp4Mime() : null;
  if (m4) { mime = m4; native = true; } else mime = webmMime();
  if (!mime) { disposeVideo(video); throw new Error('No supported recording format (neither MP4 nor WebM) in this browser.'); }
  const vStream = canvas.captureStream(fps); const tracks = [...vStream.getVideoTracks()];
  if (proj.hasAudio !== false) {
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)(); await ac.resume();
      const src = ac.createMediaElementSource(video); const gain = ac.createGain(); gain.gain.value = hl.volume ?? 1; const dest = ac.createMediaStreamDestination(); src.connect(gain); gain.connect(dest); tracks.push(...dest.stream.getAudioTracks());
    } catch (e) { warnings.push('Audio routing failed (' + e.message + ') — exported without audio.'); }
  }
  const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 128000 });
  const chunks = []; rec.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
  const stopped = new Promise((res) => (rec.onstop = res));
  const cleanup = () => { try { rec.state !== 'inactive' && rec.stop(); } catch {} tracks.forEach((t) => t.stop()); try { ac?.close(); } catch {} disposeVideo(video); };
  try {
    await seekTo(video, segs[0].start); renderFrame(ctx, video, hl, segs[0].start, 0, w, hh);
    rec.start(500); let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (i > 0) { rec.pause(); await seekTo(video, s.start); renderFrame(ctx, video, hl, s.start, acc, w, hh); rec.resume(); }
      try { await video.play(); } catch (e) { if (!warnings.some((x) => x.includes('muted'))) warnings.push('The browser blocked unmuted playback, so the clip may have no audio.'); video.muted = true; await video.play(); }
      await new Promise((resolve, reject) => {
        const tick = () => {
          if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
          const t = video.currentTime; const out = acc + clamp(t - s.start, 0, s.end - s.start);
          renderFrame(ctx, video, hl, t, out, w, hh); onProgress?.(clamp(out / total, 0, 1));
          if (t >= s.end - 0.02 || video.ended) return resolve();
          // (requestVideoFrameCallback does not fire for detached <video> elements, so drive frames with rAF / timers.)
          if (document.visibilityState === 'visible') requestAnimationFrame(tick); else setTimeout(tick, 1000 / fps);
        };
        tick();
      });
      video.pause(); acc += s.end - s.start;
    }
    await new Promise((r) => setTimeout(r, 250)); // let the encoder flush the last frame
    rec.stop(); await stopped;
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    return { blob, mime, ext: native ? 'mp4' : 'webm', native, warnings, duration: total };
  } catch (e) { cleanup(); throw e; } finally { tracks.forEach((t) => t.stop()); try { ac?.close(); } catch {} disposeVideo(video); }
}

/** Verify the produced file by actually decoding it. Never report success without this. */
export async function verifyOutput(blob, { w, h, duration, expectAudio }) {
  const v = { ok: false, problems: [], width: 0, height: 0, duration: 0, audio: null };
  if (!blob || blob.size < 2048) { v.problems.push('Output file is empty or too small.'); return v; }
  const url = URL.createObjectURL(blob);
  try {
    const el = await loadVideo(url, { muted: true, timeout: 20000 });
    v.width = el.videoWidth; v.height = el.videoHeight; v.duration = el.duration;
    if (v.width !== w || v.height !== h) v.problems.push(`Unexpected size ${v.width}×${v.height} (expected ${w}×${h}).`);
    if (!isFinite(v.duration) || Math.abs(v.duration - duration) > Math.max(1.5, duration * 0.1)) v.problems.push(`Duration ${v.duration?.toFixed?.(1)}s differs from expected ${duration.toFixed(1)}s.`);
    disposeVideo(el);
    if (expectAudio) {
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)(); const buf = await ac.decodeAudioData(await blob.arrayBuffer()); let pk = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i += 7) pk = Math.max(pk, Math.abs(d[i])); }
        v.audio = pk > 1e-4 ? 'audible' : 'silent'; ac.close();
      } catch { v.audio = 'undecodable'; }
    }
    v.ok = v.problems.length === 0;
  } catch (e) { v.problems.push('The exported file could not be decoded: ' + e.message); } finally { URL.revokeObjectURL(url); }
  return v;
}

/** Full export for one clip. Returns {blob, ext, mime, verified, warnings, cover}. */
export async function exportClip(hl, proj, opts, cb = {}) {
  const [w, h] = opts.resolution.split('x').map(Number); const fps = opts.fps || 30; const bitrate = w >= 1080 ? 8e6 : 5e6;
  const { onStage, onProgress, signal } = cb; const warnings = [];
  if (hl.crop?.mode === 'follow' && !(hl.track && hl.track.from === hl.start && hl.track.to === hl.end)) { onStage?.('Tracking subject'); await ensureTrack(hl, proj, { signal, onProgress: (p) => onProgress?.(p * 0.1) }); }
  onStage?.('Rendering'); const r = await renderClip(hl, proj, { w, h, fps, format: opts.format, bitrate }, { onProgress: (p) => onProgress?.(p * (opts.format === 'mp4' && !nativeMp4Mime() ? 0.55 : 0.9)), signal });
  warnings.push(...r.warnings); let { blob, ext, mime } = r;
  if (opts.format === 'mp4' && ext === 'webm') {
    onStage?.('Encoding MP4 (FFmpeg)');
    try { blob = await transcodeToMp4(blob, { w, h, signal, onProgress: (p) => onProgress?.(0.55 + p * 0.35) }); ext = 'mp4'; mime = 'video/mp4'; }
    catch (e) { if (e.name === 'AbortError') throw e; warnings.push(`MP4 encoding unavailable (${e.message}). Delivered WebM instead.`); }
  }
  onStage?.('Verifying'); onProgress?.(0.93);
  const verified = await verifyOutput(blob, { w, h, duration: r.duration, expectAudio: proj.hasAudio !== false && (hl.volume ?? 1) > 0 });
  if (verified.audio === 'silent' || verified.audio === 'undecodable') warnings.push(`No audible audio was detected in the exported file (${verified.audio}).`);
  if (!verified.ok) throw new Error('Verification failed: ' + verified.problems.join(' '));
  const cover = await makeCover(hl, proj, opts.coverTime ?? hl.peak, w, h).catch(() => null);
  onProgress?.(1); return { blob, ext, mime, verified, warnings, cover, width: w, height: h, duration: r.duration };
}

export async function makeCover(hl, proj, srcTime, w = 1080, h = 1920) {
  const url = await getMediaUrl(proj.id); if (!url) return null;
  const v = await loadVideo(url, { muted: true });
  try { await seekTo(v, clamp(srcTime, 0, v.duration - 0.05)); const c = document.createElement('canvas'); c.width = w; c.height = h; renderFrame(c.getContext('2d'), v, { ...hl, overlays: hl.overlays?.filter((o) => o.outStart == null || o.outStart <= 0) || [] }, srcTime, 0, w, h); return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9)); }
  finally { disposeVideo(v); }
}

// ================= Content optimisation (transparent templates, no AI service) =================
const TAGS = { base: ['#GTA6', '#GTAVI', '#gaming', '#gameplay'], explosion: ['#explosion', '#gtamoments'], police: ['#policechase', '#wanted'], crash: ['#carcrash', '#gtafails'], driving: ['#drifting', '#driving'], funny: ['#funny', '#gamingfunny'], fail: ['#fail', '#gamingfails'], reaction: ['#reaction', '#streamer'], action: ['#action', '#shootout'], epic: ['#epic', '#gamingclips'], unexpected: ['#unexpected', '#gamingmoments'], escape: ['#escape', '#closecall'], close: ['#closecall'], discovery: ['#easteregg', '#secret'], story: ['#storymode'], npc: ['#npc', '#gtaai'], review: ['#gamingclips'] };
const TITLES = { explosion: ['This GTA 6 explosion came out of nowhere', 'Boom — GTA 6 explosion moment'], police: ['GTA 6 police chase gets out of hand', 'Can you escape the cops in GTA 6?'], crash: ['GTA 6 crash you have to see', 'That crash was not supposed to happen'], driving: ['Insane driving moment in GTA 6', 'GTA 6 driving that should not work'], funny: ['This GTA 6 moment is hilarious', 'GTA 6 gone wrong (funny)'], fail: ['GTA 6 fail moment', 'Worst luck in GTA 6'], reaction: ['My reaction says it all — GTA 6', 'Wait for the reaction — GTA 6'], action: ['Non-stop action in GTA 6', 'GTA 6 action sequence'], epic: ['Epic GTA 6 moment', 'One of the wildest GTA 6 moments'], unexpected: ['I did not expect that in GTA 6', 'Unexpected GTA 6 moment'], escape: ['Insane GTA 6 escape', 'Somehow I got away — GTA 6'], close: ['Closest call yet in GTA 6'], discovery: ['Look what I found in GTA 6'], story: ['GTA 6 story moment'], npc: ['This NPC did something unexpected in GTA 6'], review: ['GTA 6 gameplay highlight'] };
export function suggestContent(hl, proj, tl) {
  const cat = hl.category || 'review'; const dur = outDuration(segmentsOf(hl));
  const pick = (a) => a[Math.abs(hl.title.length + Math.round(hl.start)) % a.length];
  const kw = [...new Set((tl?.speech?.segments || []).filter((s) => s.t >= hl.start && s.t <= hl.end).flatMap((s) => (s.hits || []).map((x) => x.phrase)))];
  const title = (TITLES[cat] || TITLES.review); const t = pick(title);
  const hook = hl.overlays?.find((o) => o.isHook)?.text || (hl.captions[0]?.text ?? '');
  const tags = [...new Set([...TAGS.base, ...(TAGS[cat] || [])])];
  const keywords = [...new Set(['GTA 6', 'GTA VI', 'gameplay', 'highlights', categoryLabel(cat).toLowerCase(), ...kw.map((k) => k.toLowerCase()), ...(hl.title ? hl.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3) : [])])].slice(0, 15);
  const advice = dur < 8 ? 'Very short; consider extending the setup.' : dur <= 45 ? 'Length is within the commonly used 15–45 s range for short-form.' : dur <= 60 ? 'Slightly long for short-form; consider trimming if retention drops.' : 'Long for short-form; consider trimming to the core moment.';
  return {
    bestHook: hl.hooks?.find((x) => x.id === hl.selectedHook)?.name || '—', bestDuration: `${dur.toFixed(0)} s — ${advice}`, bestOpening: `Opens at ${fmtTime(segmentsOf(hl)[0].start, true)}`, bestCaption: hook || '(add a caption or hook text)', suggestedThumbnailTime: hl.peak,
    title: t.slice(0, 95), reelsCaption: `${hook ? hook + '\n\n' : ''}${t}.\n\n${tags.slice(0, 8).join(' ')}`,
    shortsDescription: `${t}.\nGameplay recorded by me. ${proj.name}.\n\n${[...tags, '#Shorts'].join(' ')}`, hashtags: [...tags, '#Reels', '#Shorts'], keywords,
    note: 'Template-based suggestions from the clip’s detected category and speech keywords — no AI service is connected and nothing here predicts performance.',
  };
}

// ================= ZIP (store-only; videos are already compressed) =================
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export async function makeZip(files) {
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0; const d = new Date();
  const dosT = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, dosD = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  for (const f of files) {
    const data = f.blob ? new Uint8Array(await f.blob.arrayBuffer()) : enc.encode(f.text); const name = enc.encode(f.name); const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint16(10, dosT, true); lh.setUint16(12, dosD, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosT, true); ch.setUint16(14, dosD, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name); offset += 30 + name.length + data.length;
  }
  const csize = central.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
