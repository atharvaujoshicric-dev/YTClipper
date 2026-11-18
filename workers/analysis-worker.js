// Off-main-thread audio feature extraction so the UI never blocks during analysis.
import { computeAudioTimeline } from '../js/dsp.js';
self.onmessage = (e) => {
  const { type, samples, sampleRate, step, id } = e.data;
  if (type !== 'audio') return;
  try {
    const feats = computeAudioTimeline(samples, sampleRate, step, (p) => self.postMessage({ id, progress: p }));
    const transfer = Object.values(feats).map((a) => a.buffer);
    self.postMessage({ id, done: true, feats }, transfer);
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
