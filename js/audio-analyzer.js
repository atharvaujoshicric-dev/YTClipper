// Audio analysis: offline (decode + worker DSP) and live (AudioWorklet tap). Generic energy classes only — no model, no sound labelling.
import { computeAudioTimeline, AudioWindower, AUDIO_KEYS } from './dsp.js';
import { clamp } from './utils.js';

export const AUDIO_STEP = 0.5;
const AC = () => window.AudioContext || window.webkitAudioContext;

function decode(ac, buf) {
  return new Promise((res, rej) => { const p = ac.decodeAudioData(buf, res, rej); if (p?.then) p.then(res, rej); });
}
function runWorker(samples, sampleRate, step, onProgress) {
  return new Promise((resolve) => {
    let worker;
    try { worker = new Worker(new URL('../workers/analysis-worker.js', import.meta.url), { type: 'module' }); } catch { worker = null; }
    if (!worker) return resolve(computeAudioTimeline(samples, sampleRate, step, onProgress));
    const id = Math.random();
    const fallback = () => { try { worker.terminate(); } catch {} resolve(computeAudioTimeline(samples, sampleRate, step, onProgress)); };
    worker.onmessage = (e) => {
      if (e.data.id !== id) return;
      if (e.data.progress != null) onProgress?.(e.data.progress);
      if (e.data.done) { worker.terminate(); resolve(e.data.feats); }
      if (e.data.error) fallback();
    };
    worker.onerror = fallback;
    worker.postMessage({ type: 'audio', samples, sampleRate, step, id }, [samples.buffer]);
  });
}

/** Decode the file's audio at 16 kHz mono and compute per-0.5 s features. */
export async function analyzeAudioFile(blob, { onProgress, signal, maxDecodeMB = 600, videoEl } = {}) {
  if (!AC()) return { available: false, reason: 'Web Audio API is not available in this browser.' };
  if (blob.size > maxDecodeMB * 1048576) {
    if (!videoEl) return { available: false, reason: `File is larger than ${maxDecodeMB} MB; skipped full audio decode.` };
    return analyzeAudioRealtime(videoEl, { onProgress, signal });
  }
  const ac = new (AC())({ sampleRate: 16000 });
  try {
    onProgress?.(0.02);
    const ab = await blob.arrayBuffer();
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    let audio;
    try { audio = await decode(ac, ab); }
    catch (e) { return { available: false, reason: 'No decodable audio track (the file may be silent/without audio, or uses an audio codec this browser cannot decode).' }; }
    const n = audio.length, ch = audio.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    const duration = audio.duration, sr = audio.sampleRate;
    const features = await runWorker(mono, sr, AUDIO_STEP, (p) => onProgress?.(0.1 + p * 0.9));
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const peakDb = Math.max(...features.peakDb);
    if (peakDb < -80) return { available: false, reason: 'The audio track is digital silence.', duration };
    return { available: true, step: AUDIO_STEP, features, duration, method: 'decode' };
  } finally { try { ac.close()?.catch?.(() => {}); } catch {} }
}

/** Fallback for very large files: play the (muted) video at 2x and tap its audio. */
export async function analyzeAudioRealtime(video, { onProgress, signal } = {}) {
  const ac = new (AC())();
  const dur = video.duration; const n = Math.ceil(dur / AUDIO_STEP);
  const feats = {}; AUDIO_KEYS.forEach((k) => (feats[k] = new Float32Array(n).fill(k === 'rmsDb' || k === 'peakDb' ? -120 : 0)));
  try {
    await ac.audioWorklet.addModule(new URL('../workers/audio-tap-worklet.js', import.meta.url));
    const src = ac.createMediaElementSource(video);
    const tap = new AudioWorkletNode(ac, 'clipforge-tap');
    src.connect(tap);
    const w = new AudioWindower(ac.sampleRate, AUDIO_STEP / 2, (f) => {
      const b = clamp(Math.floor(video.currentTime / AUDIO_STEP), 0, n - 1);
      AUDIO_KEYS.forEach((k) => { if (f[k] > feats[k][b]) feats[k][b] = f[k]; });
    });
    tap.port.onmessage = (e) => w.push(e.data);
    video.muted = false; video.playbackRate = 2; video.currentTime = 0;
    await ac.resume(); await video.play();
    await new Promise((res) => {
      const iv = setInterval(() => { onProgress?.(video.currentTime / dur); if (video.ended || signal?.aborted) { clearInterval(iv); res(); } }, 300);
      video.addEventListener('ended', () => { clearInterval(iv); res(); }, { once: true });
    });
    video.pause();
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    return { available: true, step: AUDIO_STEP, features: feats, duration: dur, method: 'realtime-2x' };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { available: false, reason: 'Real-time audio tap failed: ' + e.message };
  } finally { try { ac.close()?.catch?.(() => {}); } catch {} }
}

/** Live audio meter on a MediaStream (screen-capture audio). Emits 0.5 s feature windows + a level for the VU meter. */
export class LiveAudioAnalyzer {
  constructor(stream, { onWindow, onLevel }) { this.stream = stream; this.onWindow = onWindow; this.onLevel = onLevel; this.ac = null; this.ok = false; }
  async start() {
    if (!this.stream.getAudioTracks().length) return false;
    this.ac = new (AC())(); await this.ac.resume();
    const src = this.ac.createMediaStreamSource(new MediaStream(this.stream.getAudioTracks()));
    this.windower = new AudioWindower(this.ac.sampleRate, AUDIO_STEP, (f, i) => this.onWindow(f, i));
    this.analyser = this.ac.createAnalyser(); this.analyser.fftSize = 1024; src.connect(this.analyser);
    const level = new Float32Array(1024);
    this._lv = setInterval(() => { this.analyser.getFloatTimeDomainData(level); let s = 0; for (const v of level) s += v * v; this.onLevel?.(Math.sqrt(s / level.length)); }, 80);
    try {
      await this.ac.audioWorklet.addModule(new URL('../workers/audio-tap-worklet.js', import.meta.url));
      const tap = new AudioWorkletNode(this.ac, 'clipforge-tap'); src.connect(tap); tap.port.onmessage = (e) => { if (!this.paused) this.windower.push(e.data); };
    } catch {
      const sp = this.ac.createScriptProcessor(2048, 1, 1); src.connect(sp); sp.connect(this.ac.destination);
      sp.onaudioprocess = (e) => { if (!this.paused) this.windower.push(new Float32Array(e.inputBuffer.getChannelData(0))); e.outputBuffer.getChannelData(0).fill(0); };
    }
    this.ok = true; return true;
  }
  stop() { clearInterval(this._lv); try { this.ac?.close()?.catch?.(() => {}); } catch {} }
}
