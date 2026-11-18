// Highlight detection orchestrator: signals -> peaks -> clusters -> bounds -> classification -> score -> candidates.
import { uid, clamp, median } from './utils.js';
import { computeSignals, baseScoreSeries, scoreHighlight, prefSignal, confidenceFrom, STEP } from './engagement-scorer.js';
import { findPeaks, growRegion, clusterEvents, boundsFor, dedupeClips } from './clip-extractor.js';
import { classify, explainSignals, categoryLabel } from './event-classifier.js';

export function detectHighlights(tl, settings, prefs, { projectId, minAgeSec = 0 } = {}) {
  if (!tl.audio?.available && !tl.visual?.available) {
    return { highlights: [], sig: null, info: { error: 'Neither audio nor visual analysis produced data, so nothing can be detected.' } };
  }
  const sig = computeSignals(tl, settings);
  const base = baseScoreSeries(sig, settings.weights);
  const peaks = findPeaks(base, 0.25);
  const baseMed = median(base);
  const events = peaks.map((p) => growRegion(base, p.i, 0.5, 0.18, baseMed));
  const clusters = clusterEvents(events, base, Math.round(settings.mergeGap / STEP));
  let clips = [];
  for (const ev of clusters) {
    if (minAgeSec && ev.i1 * STEP > tl.duration - minAgeSec) continue; // live: wait for the payoff to finish
    const b = boundsFor(ev, tl, sig, settings);
    let sc = scoreHighlight(sig, settings.weights, ev.peak, 0.5);
    const cls = classify(tl, sig, ev, sc.signals, sc.score, settings);
    sc = scoreHighlight(sig, settings.weights, ev.peak, prefSignal(prefs, cls.category));
    const conf = confidenceFrom(sc.signals, cls.categoryConf);
    const reasons = [...explainSignals(tl, sig, ev, sc.signals), ...cls.reasons];
    if (ev.merged > 1) reasons.push(`${ev.merged} nearby detections were combined into one contextual highlight.`);
    if (!sig.avail.speech || sig.speechMethod.startsWith('voice')) reasons.push('Speech recognition unavailable for this footage — reaction strength uses a voice-band loudness proxy.');
    clips.push({
      id: uid('hl'), projectId, createdAt: Date.now(), manual: false,
      start: b.start, end: b.end, eventStart: b.eventStart, eventEnd: b.eventEnd, peak: +(ev.peak * STEP).toFixed(2),
      score: sc.score, signals: sc.signals, weightsUsed: sc.weightsUsed,
      category: cls.category, categoryAuto: cls.category, categoryMethod: cls.method, categoryConf: cls.categoryConf, alternates: cls.alternates,
      confidence: conf.level, confidencePct: conf.pct, reasons,
      title: `${categoryLabel(cls.category).replace('Potential Highlight — Needs Review', 'Highlight')} at ${Math.floor(b.eventStart / 60)}:${String(Math.floor(b.eventStart % 60)).padStart(2, '0')}`,
      status: 'candidate', feedback: [], captions: [], overlays: [], hooks: [], selectedHook: null,
      crop: { mode: settings.cropMode, x: 0.5 }, volume: 1, captionsEnabled: settings.captionsEnabled,
      captionStyle: { theme: settings.captionTheme, size: settings.captionFontSize, outline: settings.captionOutline, box: settings.captionBox, highlight: settings.captionHighlight, y: 0.7 },
      meta: {}, exportedCount: 0, thumb: null,
    });
  }
  clips = dedupeClips(clips, settings).filter((c) => c.score >= settings.minScore);
  clips.sort((a, b) => b.score - a.score);
  const total = clips.length;
  clips = clips.slice(0, settings.maxCandidates);
  return { highlights: clips, sig, info: { rawPeaks: peaks.length, clusters: clusters.length, kept: clips.length, droppedByLimit: Math.max(0, total - clips.length) } };
}

/** Create a highlight around a user-chosen time (manual flag / "add highlight at playhead"). */
export function manualHighlight(tl, t, settings, prefs, projectId) {
  const sig = computeSignals(tl, settings);
  const peak = clamp(Math.round(t / STEP), 0, sig.n - 1);
  const ev = { i0: Math.max(0, peak - 2), i1: Math.min(sig.n - 1, peak + 2), peak };
  const b = boundsFor(ev, tl, sig, settings);
  let sc = scoreHighlight(sig, settings.weights, peak, 0.5);
  const cls = classify(tl, sig, ev, sc.signals, sc.score, settings);
  sc = scoreHighlight(sig, settings.weights, peak, prefSignal(prefs, cls.category));
  const conf = confidenceFrom(sc.signals, cls.categoryConf);
  const mm = Math.floor(b.eventStart / 60), ss = String(Math.floor(b.eventStart % 60)).padStart(2, '0');
  return {
    id: uid('hl'), projectId, createdAt: Date.now(), manual: true, start: b.start, end: b.end, eventStart: b.eventStart, eventEnd: b.eventEnd, peak: +(peak * STEP).toFixed(2),
    score: sc.score, signals: sc.signals, weightsUsed: sc.weightsUsed, category: cls.category, categoryAuto: cls.category, categoryMethod: cls.method, categoryConf: cls.categoryConf, alternates: cls.alternates,
    confidence: conf.level, confidencePct: conf.pct, reasons: ['Added manually at ' + mm + ':' + ss + '.', ...explainSignals(tl, sig, ev, sc.signals), ...cls.reasons],
    title: `Marked moment at ${mm}:${ss}`, status: 'candidate', feedback: [], captions: [], overlays: [], hooks: [], selectedHook: null,
    crop: { mode: settings.cropMode, x: 0.5 }, volume: 1, captionsEnabled: settings.captionsEnabled,
    captionStyle: { theme: settings.captionTheme, size: settings.captionFontSize, outline: settings.captionOutline, box: settings.captionBox, highlight: settings.captionHighlight, y: 0.7 },
    meta: {}, exportedCount: 0, thumb: null,
  };
}
