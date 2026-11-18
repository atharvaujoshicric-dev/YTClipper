// Explainable multi-signal engagement-potential heuristic (NOT a prediction of views, reach or virality).
import { clamp, median, mad } from './utils.js';

export const STEP = 0.5;
export const SIGNAL_META = {
  audio: { label: 'Audio excitement', short: 'Audio' },
  visual: { label: 'Visual activity', short: 'Visual' },
  speech: { label: 'Speech / reaction', short: 'Speech' },
  unexpected: { label: 'Unexpected activity', short: 'Unexpected' },
  scene: { label: 'Scene / context change', short: 'Scene' },
  prefs: { label: 'User preferences', short: 'Prefs' },
};
const sq = (z, g) => (z <= 0 ? 0 : 1 - Math.exp((-z * g) / 2.2));
const get = (o, k, i) => (o && o[k] && i >= 0 && i < o[k].length ? o[k][i] : 0);

function robust(arr, floor) {
  const med = median(arr), sigma = Math.max(1.4826 * mad(arr, med), floor);
  return { med, sigma };
}
function rollingMedian(arr, i, from, to) {
  const a = []; for (let j = Math.max(0, i - from); j <= i - to; j++) a.push(arr[j]);
  return a.length ? median(a) : arr[i];
}

/** Normalise raw timeline features into 0..1 signals on the 0.5 s grid. */
export function computeSignals(tl, settings) {
  const n = Math.max(1, Math.ceil(tl.duration / STEP));
  const gA = 0.5 + (settings.audioSensitivity ?? 50) / 100, gV = 0.5 + (settings.visualSensitivity ?? 50) / 100;
  const sig = { n, step: STEP, audio: new Float32Array(n), visual: new Float32Array(n), speech: new Float32Array(n), unexpected: new Float32Array(n), scene: new Float32Array(n), raw: {}, avail: {} };
  const A = tl.audio?.available ? tl.audio : null, V = tl.visual?.available ? tl.visual : null;
  sig.avail.audio = !!A; sig.avail.visual = !!V;
  const aud0 = new Float32Array(n), vis0 = new Float32Array(n);

  if (A) {
    const rms = Array.from({ length: n }, (_, i) => get(A, 'rmsDb', i));
    const { med, sigma } = robust(rms, 3);
    const rise = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      rise[i] = rms[i] - rollingMedian(rms, i, 16, 2);
      const z = (rms[i] - med) / sigma;
      const sZ = sq(z, gA), sR = clamp((rise[i] / 12) * gA, 0, 1);
      const imp = clamp((get(A, 'crest', i) - 12) / 12, 0, 1) * clamp(rise[i] / 6, 0, 1);
      aud0[i] = clamp(0.55 * sZ + 0.3 * sR + 0.15 * imp, 0, 1);
      sig.audio[i] = aud0[i];
    }
    sig.raw.rise = rise; sig.raw.rmsMed = med; sig.raw.rmsSigma = sigma;
  }
  if (V) {
    const mo = Array.from({ length: n }, (_, i) => get(V, 'motion', i)), bd = Array.from({ length: n }, (_, i) => get(V, 'brightDelta', i)), sc = Array.from({ length: n }, (_, i) => get(V, 'scene', i));
    const rm = robust(mo, 0.008), rb = robust(bd, 0.02), rs = robust(sc, 0.05);
    for (let i = 0; i < n; i++) {
      const sM = sq((mo[i] - rm.med) / rm.sigma, gV), sF = sq((bd[i] - rb.med) / rb.sigma, gV), sS = sq((sc[i] - rs.med) / rs.sigma, gV);
      vis0[i] = clamp(0.8 * sM + 0.2 * sF, 0, 1);
      sig.visual[i] = vis0[i];
      sig.scene[i] = clamp(0.7 * sS + 0.3 * sF, 0, 1);
    }
    sig.raw.motionMed = rm.med;
  }
  // Speech: keyword hits (live capture) + voice-band burst proxy (clearly not recognition)
  const segs = tl.speech?.segments || [];
  const kw = new Float32Array(n);
  for (const s of segs) for (const hit of s.hits || []) {
    const b = Math.floor(s.t / STEP);
    for (let d = -2; d <= 6; d++) { const j = b + d; if (j >= 0 && j < n) kw[j] = Math.max(kw[j], d <= 1 ? 1 : Math.max(0.4, 1 - (d - 1) * 0.12)); }
  }
  const voiceProxy = new Float32Array(n);
  if (A && sig.raw.rise) {
    for (let i = 0; i < n; i++) { const v = get(A, 'voice', i); if (v > 0.55 && sig.raw.rise[i] > 5 && get(A, 'rmsDb', i) > -45) voiceProxy[i] = clamp(0.35 + sig.raw.rise[i] / 30, 0, 0.7); }
  }
  for (let i = 0; i < n; i++) sig.speech[i] = Math.max(kw[i], voiceProxy[i]);
  const hasKw = segs.length > 0 || !!tl.speech?.available;
  sig.avail.speech = hasKw || !!A;
  sig.speechMethod = hasKw ? 'speech-api+voice-proxy' : A ? 'voice-band proxy (not speech recognition)' : 'none';
  sig.raw.kw = kw; sig.raw.voiceProxy = voiceProxy;

  // Unexpected: sudden jump of combined activity relative to the preceding calm baseline
  const act = new Float32Array(n);
  const k = (A ? 1 : 0) + (V ? 1 : 0);
  for (let i = 0; i < n; i++) act[i] = k ? (aud0[i] + vis0[i]) / k : 0;
  for (let i = 0; i < n; i++) {
    let pk = 0; for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) pk = Math.max(pk, act[j]);
    const base = i >= 6 ? rollingMedian(act, i, 24, 4) : 0;
    sig.unexpected[i] = k ? clamp((pk - base) / 0.55, 0, 1) : 0;
  }
  sig.avail.unexpected = k > 0; sig.avail.scene = !!V;
  return sig;
}

export function weightsFor(sig, weights, { includePrefs = false } = {}) {
  const w = {};
  for (const k of ['audio', 'visual', 'speech', 'unexpected', 'scene']) w[k] = sig.avail[k] ? weights[k] || 0 : 0;
  if (includePrefs) w.prefs = weights.prefs || 0;
  return w;
}

/** Per-bin base score (0..1) used to find candidate peaks (no user-preference term). */
export function baseScoreSeries(sig, weights) {
  const w = weightsFor(sig, weights); const tot = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const raw = new Float32Array(sig.n);
  for (let i = 0; i < sig.n; i++) raw[i] = (w.audio * sig.audio[i] + w.visual * sig.visual[i] + w.speech * sig.speech[i] + w.unexpected * sig.unexpected[i] + w.scene * sig.scene[i]) / tot;
  const out = new Float32Array(sig.n);
  for (let i = 0; i < sig.n; i++) out[i] = (raw[Math.max(0, i - 1)] + 2 * raw[i] + raw[Math.min(sig.n - 1, i + 1)]) / 4;
  return out;
}

/** Final highlight score from the strongest signal values around the event peak. */
export function scoreHighlight(sig, weights, peakBin, prefSig = 0.5) {
  const lo = Math.max(0, peakBin - 2), hi = Math.min(sig.n - 1, peakBin + 2);
  const sv = {};
  for (const k of ['audio', 'visual', 'speech', 'unexpected', 'scene']) { let m = 0; for (let i = lo; i <= hi; i++) m = Math.max(m, sig[k][i]); sv[k] = sig.avail[k] ? m : null; }
  sv.prefs = prefSig;
  const w = weightsFor(sig, weights, { includePrefs: true });
  let num = 0, den = 0;
  for (const k of Object.keys(w)) { if (w[k] > 0 && sv[k] != null) { num += w[k] * sv[k]; den += w[k]; } }
  return { score: Math.round(clamp(den ? (num / den) * 100 : 0, 0, 100)), signals: sv, weightsUsed: w };
}

/** Rules-based preference signal from local user feedback (not a trained model). 0.5 = neutral. */
export function prefSignal(prefs, category) {
  const c = prefs?.category?.[category]; if (!c) return 0.5;
  const net = (c.up || 0) - (c.down || 0) - (c.wrong || 0) * 0.5;
  return clamp(0.5 + net * 0.1, 0, 1);
}

export function confidenceFrom(signals, categoryConf = 0.5) {
  const vals = Object.entries(signals).filter(([k, v]) => k !== 'prefs' && v != null).map(([, v]) => v);
  const strong = vals.filter((v) => v >= 0.6).length;
  const pct = clamp(0.25 + strong * 0.14 + categoryConf * 0.25, 0, 0.97);
  return { pct: Math.round(pct * 100), level: pct >= 0.72 ? 'High' : pct >= 0.5 ? 'Medium' : 'Low' };
}
