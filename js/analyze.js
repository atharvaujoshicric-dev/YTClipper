// Analysis pipeline: IMPORT → ANALYZE → DETECT → RANK (hooks + thumbnails) with progress and cancellation.
import { state, getMediaBlob, getMediaUrl, saveProject, saveTimeline, getTimeline, replaceProjectHighlights, setProcessing, endProcessing, addHistory, highlightsOf, saveHighlights } from './state.js';
import { loadVideo, disposeVideo, toast, clamp } from './utils.js';
import { analyzeAudioFile } from './audio-analyzer.js';
import { analyzeVideoVisual, grabFrame } from './visual-analyzer.js';
import { detectHighlights } from './highlight-detector.js';
import { generateHooks } from './hook-intelligence.js';
import { STEP } from './engagement-scorer.js';

let running = null;
export const isAnalyzing = () => !!running;

function report(label, pct) { setProcessing({ active: true, label, pct: Math.round(pct * 100) }); }

export async function analyzeProject(project, { onDone } = {}) {
  if (running) { toast('Another analysis is already running. Cancel it or wait for it to finish.', 'warn'); return null; }
  const ac = new AbortController(); running = ac;
  const t0 = performance.now();
  setProcessing({ active: true, label: `Analysing “${project.name}”`, pct: 0, cancel: () => ac.abort(), error: null });
  project.status = 'analyzing'; project.error = null; await saveProject(project);
  let video = null;
  try {
    const blob = await getMediaBlob(project.id);
    if (!blob) throw new Error('The source video is not loaded. Re-link it from the Video Library, then try again.');
    const url = await getMediaUrl(project.id);
    video = await loadVideo(url);
    const duration = isFinite(video.duration) ? video.duration : project.duration;
    if (!duration) throw new Error('Could not determine the video duration (the file may be corrupt or use an unsupported codec).');
    const info = { audio: null, visual: null, speech: null };

    report('Analysing audio…', 0.02);
    const audio = await analyzeAudioFile(blob, { signal: ac.signal, maxDecodeMB: state.settings.audioDecodeMaxMB ?? 600, videoEl: video, onProgress: (p) => report('Analysing audio…', 0.02 + p * 0.28) });
    info.audio = audio.available ? { available: true, method: audio.method } : { available: false, reason: audio.reason };
    if (audio.available) project.hasAudio = true; else project.hasAudio = false;

    report('Sampling frames…', 0.3);
    video.muted = true;
    const autoInterval = duration > 3600 ? 2 : duration > 900 ? 1 : 0.5; // keep long recordings tractable
    const visual = await analyzeVideoVisual(video, { interval: Math.max(state.settings.visualInterval, autoInterval), signal: ac.signal, onProgress: (p) => report('Sampling frames…', 0.3 + p * 0.5) });
    info.visual = { available: true, interval: visual.interval };

    const prev = await getTimeline(project.id);
    const tl = {
      projectId: project.id, step: STEP, duration, createdAt: Date.now(),
      audio: audio.available ? { available: true, method: audio.method, ...audio.features } : { available: false, reason: audio.reason },
      visual: { available: true, interval: visual.interval, ...visual.features },
      speech: prev?.speech?.segments?.length ? prev.speech : { available: false, segments: [], reason: 'Speech recognition cannot transcribe uploaded files in the browser; it only works on a live microphone.' },
    };
    info.speech = tl.speech.available === false ? { available: false, reason: tl.speech.reason } : { available: true, segments: tl.speech.segments.length };
    await saveTimeline(tl);

    report('Detecting highlights…', 0.82);
    await finishDetection(project, tl, video, ac.signal, info, (p, l) => report(l, 0.82 + p * 0.17));
    project.analysisInfo = { ...info, ms: Math.round(performance.now() - t0) };
    project.status = 'analyzed'; project.analyzedAt = Date.now();
    project.stats = { highlights: highlightsOf(project.id).length };
    await saveProject(project);
    endProcessing('Analysis complete');
    await addHistory('analysis', 'success', `Detected ${project.stats.highlights} highlight(s) in ${Math.round((performance.now() - t0) / 1000)} s`, project);
    toast(`Analysis complete: ${project.stats.highlights} highlight candidate(s).`, 'success');
    onDone?.(project);
    return project;
  } catch (e) {
    if (e.name === 'AbortError') {
      project.status = 'interrupted'; await saveProject(project); endProcessing('Cancelled');
      await addHistory('analysis', 'cancelled', 'Analysis cancelled', project); toast('Analysis cancelled. You can resume it from the Video Library.', 'warn');
    } else {
      console.error(e); project.status = 'error'; project.error = e.message; await saveProject(project); endProcessing('Analysis failed', e.message);
      await addHistory('analysis', 'failed', e.message, project); toast('Analysis failed: ' + e.message, 'error', 9000);
    }
    return null;
  } finally { if (video) disposeVideo(video); running = null; }
}

/** Run detection + hooks + thumbnails on an existing timeline (also used for live captures and re-detection). */
export async function finishDetection(project, tl, video, signal, info, progress) {
  const res = detectHighlights(tl, state.settings, state.prefs, { projectId: project.id });
  if (res.info?.error) throw new Error(res.info.error);
  let i = 0;
  for (const hl of res.highlights) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    Object.assign(hl, generateHooks(hl, tl, state.settings, state.prefs));
    if (video) { try { hl.thumb = await grabFrame(video, clamp(hl.peak, 0, (video.duration || tl.duration) - 0.1)); } catch { hl.thumb = null; } }
    progress?.(++i / Math.max(1, res.highlights.length), 'Preparing highlights & hooks…');
  }
  await replaceProjectHighlights(project.id, res.highlights);
  return res;
}

export async function redetectProject(project) {
  const tl = await getTimeline(project.id);
  if (!tl) { toast('No stored analysis data for this project. Run a full analysis first.', 'warn'); return null; }
  let video = null;
  try {
    setProcessing({ active: true, label: 'Re-running detection…', pct: 10, cancel: null, error: null });
    const url = await getMediaUrl(project.id); if (url) { try { video = await loadVideo(url); } catch {} }
    await finishDetection(project, tl, video, null, null, (p) => setProcessing({ pct: 10 + p * 85 }));
    project.stats = { highlights: highlightsOf(project.id).length }; project.status = 'analyzed'; await saveProject(project);
    endProcessing('Detection updated');
    await addHistory('detection', 'success', `Re-detected: ${project.stats.highlights} highlight(s) with current settings`, project);
    toast(`Detection updated: ${project.stats.highlights} candidate(s). Approved and manual clips were kept.`, 'success');
    return project;
  } catch (e) { endProcessing('Detection failed', e.message); toast('Detection failed: ' + e.message, 'error', 8000); return null; }
  finally { if (video) disposeVideo(video); }
}
