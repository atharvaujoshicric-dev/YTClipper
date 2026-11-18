// Subject follow for 9:16 crops. Real, measured tracking of where localized motion is — NOT object recognition.
// It follows the dominant moving region (a car, a character, an explosion) between sampled frames; it does not know what the object is.
import { clamp, seekTo, loadVideo, disposeVideo } from './utils.js';
import { getMediaUrl } from './state.js';

const W = 128, H = 72;

/** Interpolated crop centre (0..1) at source time t. */
export function trackX(track, t) {
  const xs = track?.xs; if (!xs?.length) return 0.5;
  const f = (t - track.t0) / track.dt; if (f <= 0) return xs[0]; if (f >= xs.length - 1) return xs[xs.length - 1];
  const i = Math.floor(f), a = f - i; return xs[i] * (1 - a) + xs[i + 1] * a;
}

/** Pure path-solver, exported for testing: per-sample column energy → smoothed crop centres. */
export function solvePath(cols, cropFrac) {
  const n = cols.length; const half = cropFrac / 2; const wc = Math.max(3, Math.round(cropFrac * W));
  const raw = new Array(n).fill(null), conf = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    const e = cols[k]; if (!e) continue;
    const sorted = Float32Array.from(e).sort(); const bg = sorted[Math.floor(sorted.length * 0.5)];
    const loc = Float32Array.from(e, (v) => Math.max(0, v - bg * 1.2)); // remove background/global motion level
    let total = 0; for (const v of loc) total += v; if (total < 2.5) continue;
    let win = 0; for (let x = 0; x < wc; x++) win += loc[x]; let best = win, bi = 0;
    for (let x = 1; x + wc <= W; x++) { win += loc[x + wc - 1] - loc[x - 1]; if (win > best) { best = win; bi = x; } }
    let num = 0, den = 0; for (let x = bi; x < bi + wc; x++) { num += loc[x] * (x + 0.5); den += loc[x]; }
    raw[k] = (den ? num / den : bi + wc / 2) / W; conf[k] = best / total;
  }
  // hold last known position where nothing moved; start from the first known one
  let last = raw.find((v) => v != null) ?? 0.5; const filled = raw.map((v) => { if (v != null) last = v; return last; });
  // median filter then zero-phase smoothing, a speed limit and a dead-zone so the frame glides instead of jittering
  const med = filled.map((_, i) => { const a = filled.slice(Math.max(0, i - 2), i + 3).sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; });
  const ema = (arr, al) => { const o = arr.slice(); for (let i = 1; i < o.length; i++) o[i] = o[i - 1] + al * (arr[i] - o[i - 1]); return o; };
  let s = ema(med, 0.45).reverse(); s = ema(s, 0.45).reverse();
  const out = [s[0]]; const maxStep = 0.07, dead = 0.025;
  for (let i = 1; i < n; i++) { let d = s[i] - out[i - 1]; if (Math.abs(d) < dead) d = 0; out.push(out[i - 1] + clamp(d, -maxStep, maxStep)); }
  return out.map((x) => clamp(x, half, 1 - half));
}

/** Track the clip's source range by playing it fast (3×) and sampling frames — far quicker than seeking per frame. */
export async function trackSubject(video, from, to, { fps = 6, signal, onProgress } = {}) {
  const vw = video.videoWidth || 1920, vh = video.videoHeight || 1080;
  const cropFrac = Math.min(1, (vh * 9 / 16) / vw);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d', { willReadFrequently: true });
  const dt = 1 / fps; const ts = [], cols = []; let prev = null, moved = 0;
  const sample = (t) => {
    ctx.drawImage(video, 0, 0, W, H); const d = ctx.getImageData(0, 0, W, H).data; const g = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (d[p] * 0.3 + d[p + 1] * 0.59 + d[p + 2] * 0.11) | 0;
    ts.push(t);
    if (prev) { const e = new Float32Array(W); let any = 0; for (let y = 4; y < H - 4; y++) for (let x = 0; x < W; x++) { const v = Math.abs(g[y * W + x] - prev[y * W + x]); if (v > 14) { e[x] += v; any++; } } cols.push(e); if (any > 12) moved++; } else cols.push(null);
    prev = g; onProgress?.(clamp((t - from) / Math.max(0.01, to - from), 0, 1));
  };
  const end = Math.min(to, (video.duration || to) - 0.05);
  await seekTo(video, from); sample(video.currentTime);
  video.muted = true; video.playbackRate = 3; let last = video.currentTime, lastMove = performance.now(), stalled = false;
  try { await video.play(); } catch { stalled = true; }
  if (!stalled) await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (signal?.aborted) { clearInterval(timer); reject(new DOMException('Cancelled', 'AbortError')); return; }
      const t = video.currentTime;
      if (t > last + 1e-4) lastMove = performance.now();
      if (t - ts[ts.length - 1] >= dt * 0.9) { sample(t); last = t; }
      if (t >= end || video.ended) { clearInterval(timer); resolve(); }
      else if (performance.now() - lastMove > 2500) { clearInterval(timer); stalled = true; resolve(); }
    }, 20);
  });
  video.pause();
  if (stalled && ts[ts.length - 1] < end - dt) { // fallback: frame-accurate seeking
    for (let t = ts[ts.length - 1] + dt; t <= end + 1e-6; t += dt) { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); await seekTo(video, t); sample(t); }
  }
  const solved = solvePath(cols, cropFrac);
  // resample the (slightly irregular) samples onto a uniform grid
  const n = Math.max(2, Math.ceil((to - from) / dt) + 1); const xs = new Array(n); let k = 0;
  for (let i = 0; i < n; i++) { const t = from + i * dt; while (k < ts.length - 2 && ts[k + 1] < t) k++; const a = ts[k], b = ts[Math.min(k + 1, ts.length - 1)]; const f = b > a ? clamp((t - a) / (b - a), 0, 1) : 0; xs[i] = solved[k] * (1 - f) + solved[Math.min(k + 1, solved.length - 1)] * f; }
  return { t0: from, dt, xs, method: 'motion', coverage: +(moved / Math.max(1, cols.length - 1)).toFixed(2), fps };
}

/** Track a highlight's clip range using its stored media, and store the result on the highlight. */
export async function ensureTrack(hl, proj, { force = false, signal, onProgress } = {}) {
  if (hl.track && !force && hl.track.from === hl.start && hl.track.to === hl.end) return hl.track;
  const url = await getMediaUrl(proj.id); if (!url) throw new Error('The source video is not available for tracking.');
  const v = await loadVideo(url, { muted: true });
  try { const t = await trackSubject(v, hl.start, hl.end, { signal, onProgress }); t.from = hl.start; t.to = hl.end; hl.track = t; return t; }
  finally { disposeVideo(v); }
}
