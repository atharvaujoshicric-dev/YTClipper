// Pure DSP helpers shared by the main thread and workers (no DOM access here).
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const FFT_N = 1024;
const HANN = new Float32Array(FFT_N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1)));
export const AUDIO_KEYS = ['rmsDb', 'peakDb', 'crest', 'centroid', 'low', 'voice', 'high', 'flux'];
const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-6));

/**
 * Features for one analysis window of mono samples.
 * rmsDb/peakDb: loudness; crest: peak-rms in dB (impulsiveness); centroid: spectral centre (Hz);
 * low (<250Hz), voice (300-3400Hz), high (>3kHz): share of spectral energy; flux: spectral change vs prevMag.
 */
export function analyzeWindow(x, sr, prevMag) {
  let sum = 0, peak = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
  const rms = Math.sqrt(sum / Math.max(1, x.length));
  const out = { rmsDb: toDb(rms), peakDb: toDb(peak), crest: toDb(peak) - toDb(rms), centroid: 0, low: 0, voice: 0, high: 0, flux: 0 };
  const mag = new Float32Array(FFT_N / 2);
  const frames = Math.max(1, Math.min(4, Math.floor(x.length / FFT_N)));
  const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
  const binHz = sr / FFT_N; let tot = 0, lo = 0, vo = 0, hi = 0, cen = 0;
  for (let f = 0; f < frames; f++) {
    const off = frames === 1 ? 0 : Math.floor(((x.length - FFT_N) * f) / (frames - 1));
    for (let i = 0; i < FFT_N; i++) { re[i] = (x[off + i] || 0) * HANN[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < FFT_N / 2; k++) {
      const m = Math.hypot(re[k], im[k]); mag[k] += m / frames;
      const e = m * m, hz = k * binHz; tot += e; cen += e * hz;
      if (hz < 250) lo += e; if (hz >= 300 && hz <= 3400) vo += e; if (hz > 3000) hi += e;
    }
  }
  if (tot > 1e-9) { out.centroid = cen / tot; out.low = lo / tot; out.voice = vo / tot; out.high = hi / tot; }
  if (prevMag) {
    let d = 0, n = 0;
    for (let k = 1; k < mag.length; k++) { const a = Math.log1p(mag[k] * 50), b = Math.log1p(prevMag[k] * 50); d += Math.max(0, a - b); n++; }
    out.flux = d / n;
  }
  out._mag = mag;
  return out;
}

/** Offline timeline from a mono Float32Array. */
export function computeAudioTimeline(samples, sr, step = 0.5, onProgress) {
  const n = Math.ceil(samples.length / sr / step);
  const res = {}; AUDIO_KEYS.forEach((k) => (res[k] = new Float32Array(n)));
  const win = Math.floor(step * sr); let prev = null;
  for (let i = 0; i < n; i++) {
    const seg = samples.subarray(i * win, Math.min(samples.length, (i + 1) * win));
    const f = analyzeWindow(seg.length ? seg : new Float32Array(win), sr, prev);
    prev = f._mag; AUDIO_KEYS.forEach((k) => (res[k][i] = f[k]));
    if (onProgress && i % 200 === 0) onProgress(i / n);
  }
  return res;
}

/** Incremental windower for live audio. */
export class AudioWindower {
  constructor(sr, step, onWindow) { this.sr = sr; this.win = Math.floor(sr * step); this.buf = new Float32Array(this.win); this.fill = 0; this.prev = null; this.onWindow = onWindow; this.index = 0; }
  push(block) {
    let o = 0;
    while (o < block.length) {
      const take = Math.min(this.win - this.fill, block.length - o);
      this.buf.set(block.subarray(o, o + take), this.fill); this.fill += take; o += take;
      if (this.fill >= this.win) {
        const f = analyzeWindow(this.buf, this.sr, this.prev); this.prev = f._mag; delete f._mag;
        this.onWindow(f, this.index++); this.fill = 0;
      }
    }
  }
}
