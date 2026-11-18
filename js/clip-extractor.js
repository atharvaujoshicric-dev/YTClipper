// Contextual clip extraction: event regions, clustering, boundary refinement, de-duplication, prioritisation.
import { clamp, median } from './utils.js';
import { STEP } from './engagement-scorer.js';

export function findPeaks(base, floor, minDist = 4) {
  const peaks = [];
  const med = median(base);
  for (let i = 1; i < base.length - 1; i++) {
    if (base[i] >= floor && base[i] >= med + 0.08 && base[i] >= base[i - 1] && base[i] > base[i + 1]) {
      const last = peaks[peaks.length - 1];
      if (last && i - last.i < minDist) { if (base[i] > last.v) { last.i = i; last.v = base[i]; } } else peaks.push({ i, v: base[i] });
    }
  }
  return peaks;
}

/** Grow an event region around a peak while the score stays above a fraction of the peak (tolerating short dips). */
export function growRegion(base, peak, frac = 0.5, floor = 0.18, baseline = 0) {
  // threshold is relative to the recording's own baseline so busy footage doesn't create huge regions
  const thr = Math.max(floor, baseline + (base[peak] - baseline) * frac);
  let i0 = peak, i1 = peak, gap = 0;
  for (let i = peak - 1; i >= 0; i--) { if (base[i] >= thr) { i0 = i; gap = 0; } else if (++gap > 2) break; }
  gap = 0;
  for (let i = peak + 1; i < base.length; i++) { if (base[i] >= thr) { i1 = i; gap = 0; } else if (++gap > 2) break; }
  return { i0, i1, peak };
}

/** Event clustering: events closer than gapBins merge into one contextual highlight. */
export function clusterEvents(events, base, gapBins) {
  const ev = [...events].sort((a, b) => a.i0 - b.i0); const out = [];
  for (const e of ev) {
    const last = out[out.length - 1];
    if (last && e.i0 - last.i1 <= gapBins) {
      last.i1 = Math.max(last.i1, e.i1); last.i0 = Math.min(last.i0, e.i0);
      if (base[e.peak] > base[last.peak]) last.peak = e.peak;
      last.merged = (last.merged || 1) + 1;
    } else out.push({ ...e });
  }
  return out;
}

function activity(sig, i) { return Math.max(sig.audio[i] || 0, sig.visual[i] || 0); }

/** Silence / boundary detection: voice-band activity must be quiet at a cut point so sentences & reactions aren't clipped. */
function voiceActive(tl, i) {
  const A = tl.audio?.available ? tl.audio : null; if (!A || i < 0 || i >= A.voice.length) return false;
  return A.voice[i] > 0.5 && A.rmsDb[i] > -48;
}
export function findSilences(tl, minLen = 1.0, thresholdDb = -50) {
  const A = tl.audio?.available ? tl.audio : null; if (!A) return [];
  const out = []; let s = -1;
  for (let i = 0; i <= A.rmsDb.length; i++) {
    const quiet = i < A.rmsDb.length && A.rmsDb[i] < thresholdDb;
    if (quiet && s < 0) s = i; else if (!quiet && s >= 0) { if ((i - s) * STEP >= minLen) out.push({ from: s * STEP, to: i * STEP }); s = -1; }
  }
  return out;
}

export function boundsFor(ev, tl, sig, settings) {
  const dur = tl.duration;
  const eventStart = ev.i0 * STEP, eventEnd = (ev.i1 + 1) * STEP, core = eventEnd - eventStart;
  const pre = settings.preRoll, post = settings.postRoll, pref = settings.clipPreferred;
  const natural = core + pre + post;
  let target = natural < pref ? natural + (pref - natural) * 0.5 : Math.max(pref, core + 4);
  target = clamp(target, settings.clipMin, settings.clipMax);
  const extra = Math.max(0, target - core);
  const preShare = pre + post > 0 ? clamp(pre / (pre + post), 0.3, 0.6) : 0.5;
  let start = eventStart - extra * preShare, end = eventEnd + extra * (1 - preShare);
  if (core > settings.clipMax) { const c = ev.peak * STEP; start = c - settings.clipMax * 0.4; end = start + settings.clipMax; }
  // keep the length when we hit the file edges
  if (start < 0) { end = Math.min(dur, end - start); start = 0; }
  if (end > dur) { start = Math.max(0, start - (end - dur)); end = dur; }

  // Refine the cut points against voice activity / low-activity moments (±2-3 s).
  const bs = Math.round(start / STEP);
  let best = bs, bestA = Infinity;
  for (let i = Math.max(0, bs - 4); i <= Math.min(sig.n - 1, bs + 4); i++) { const a = activity(sig, i) + (voiceActive(tl, i) ? 0.5 : 0); if (a < bestA - 1e-6 || (Math.abs(a - bestA) < 1e-6 && Math.abs(i - bs) < Math.abs(best - bs))) { bestA = a; best = i; } }
  start = best * STEP;
  let be = Math.round(end / STEP);
  for (let k = 0; k < 6 && be < sig.n - 1 && voiceActive(tl, be); k++) be++; // let the sentence / reaction finish
  let bestE = be, bestEA = Infinity;
  for (let i = be; i <= Math.min(sig.n - 1, be + 3); i++) { const a = activity(sig, i) + (voiceActive(tl, i) ? 0.5 : 0); if (a < bestEA - 1e-6) { bestEA = a; bestE = i; } }
  end = bestE * STEP;
  // never cut inside the event itself
  start = Math.min(start, eventStart - 1); end = Math.max(end, eventEnd + 1.5);
  start = clamp(start, 0, dur); end = clamp(end, 0, dur);
  if (end - start > settings.clipMax) end = start + settings.clipMax;
  if (end - start < settings.clipMin) { end = Math.min(dur, start + settings.clipMin); start = Math.max(0, end - settings.clipMin); }
  return { start: +start.toFixed(2), end: +end.toFixed(2), eventStart, eventEnd };
}

/** Merge overlapping candidates / drop near-duplicates, keeping the stronger one. */
export function dedupeClips(clips, settings) {
  const sorted = [...clips].sort((a, b) => b.score - a.score); const kept = [];
  for (const c of sorted) {
    const dup = kept.find((k) => {
      const ov = Math.min(k.end, c.end) - Math.max(k.start, c.start);
      return ov > 0 && ov / Math.min(k.end - k.start, c.end - c.start) > 0.45;
    });
    if (!dup) { kept.push(c); continue; }
    const union = Math.max(dup.end, c.end) - Math.min(dup.start, c.start);
    if (union <= settings.clipMax) { dup.start = Math.min(dup.start, c.start); dup.end = Math.max(dup.end, c.end); dup.mergedFrom = (dup.mergedFrom || 1) + 1; dup.reasons.push('Merged with an overlapping nearby event.'); }
    // else: duplicate of a stronger clip — dropped
  }
  return kept;
}
