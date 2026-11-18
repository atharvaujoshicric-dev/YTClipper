// Visual gameplay analysis via Canvas frame sampling. Heuristic signals only (no ML model is bundled).
import { clamp, seekTo } from './utils.js';
export const VIS_STEP = 0.5;
export const VIS_KEYS = ['motion', 'scene', 'bright', 'brightDelta', 'warm', 'warmDelta', 'rb', 'motionX', 'red', 'blue'];
const W = 128, H = 72;

export class VisualExtractor {
  constructor() { this.prev = null; this.prevHist = null; this.prevBright = 0; this.prevWarm = 0; }
  reset() { this.prev = null; this.prevHist = null; }
  push(img) {
    const d = img.data, n = W * H;
    const gray = new Uint8Array(n); const hist = new Float32Array(32);
    let bsum = 0, warm = 0, red = 0, blue = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2];
      const y = (r * 77 + g * 150 + b * 29) >> 8; gray[i] = y; bsum += y; hist[y >> 3]++;
      if (r > 200 && g > 90 && g < 205 && b < 130 && r > g * 1.15) warm++;      // orange / fire-like pixels
      if (r > 170 && g < 85 && b < 85) red++;                                       // saturated red
      if (b > 170 && r < 85 && g < 130) blue++;                                     // saturated blue
    }
    for (let i = 0; i < 32; i++) hist[i] /= n;
    const f = { motion: 0, scene: 0, bright: bsum / n / 255, brightDelta: 0, warm: warm / n, warmDelta: 0, rb: Math.min(red, blue) / n, motionX: 0.5, red: red / n, blue: blue / n };
    if (this.prev) {
      let md = 0, wx = 0, ws = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; const df = Math.abs(gray[i] - this.prev[i]); md += df; if (df > 18) { wx += x * df; ws += df; } }
      f.motion = md / n / 255; f.motionX = ws > 0 ? wx / ws / W : 0.5;
      let hd = 0; for (let i = 0; i < 32; i++) hd += Math.abs(hist[i] - this.prevHist[i]); f.scene = hd / 2;
      f.brightDelta = Math.abs(f.bright - this.prevBright); f.warmDelta = Math.max(0, f.warm - this.prevWarm);
    }
    this.prev = gray; this.prevHist = hist; this.prevBright = f.bright; this.prevWarm = f.warm;
    return f;
  }
}

export function makeSampler() {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  return (video) => { ctx.drawImage(video, 0, 0, W, H); return ctx.getImageData(0, 0, W, H); };
}

/** Sample the video at `interval` seconds, seeking frame-accurately. Output arrays on the 0.5 s grid (held between samples). */
export async function analyzeVideoVisual(video, { interval = 0.5, onProgress, signal } = {}) {
  const dur = video.duration; const n = Math.ceil(dur / VIS_STEP);
  const out = {}; VIS_KEYS.forEach((k) => (out[k] = new Float32Array(n)));
  const grab = makeSampler(); const ex = new VisualExtractor();
  const stride = Math.max(1, Math.round(interval / VIS_STEP));
  let failures = 0;
  for (let i = 0; i < n; i += stride) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    try {
      await seekTo(video, Math.min(dur - 0.05, i * VIS_STEP + 0.02));
      const f = ex.push(grab(video));
      for (let j = i; j < Math.min(n, i + stride); j++) VIS_KEYS.forEach((k) => (out[k][j] = f[k]));
    } catch (e) { if (++failures > 25) throw new Error('Video decoding keeps failing while sampling frames: ' + e.message); }
    if (i % 8 === 0) { onProgress?.(i / n); await new Promise((r) => setTimeout(r)); }
  }
  return { available: true, step: VIS_STEP, features: out, duration: dur, interval };
}

export async function grabFrame(video, t, maxW = 320, quality = 0.72) {
  await seekTo(video, t);
  const ar = (video.videoWidth || 16) / (video.videoHeight || 9);
  const c = document.createElement('canvas'); c.width = maxW; c.height = Math.round(maxW / ar);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}
