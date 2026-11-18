// Optional speech/reaction analysis using the Web Speech API (live microphone only).
// Honest limits: the browser API cannot transcribe an uploaded file, and Chrome/Edge usually stream audio to an online service.
export const DEFAULT_PHRASES = ['oh my god', 'no way', 'what just happened', "let's go", 'holy shit', 'wait', 'bro', 'are you serious', "i can't believe it"];

export const speechSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
const norm = (s) => String(s).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9À-ɏ\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Returns [{phrase, custom}] for every configured phrase found as whole words in text. */
export function matchKeywords(text, settings) {
  const t = ' ' + norm(text) + ' ';
  const hits = [];
  const off = new Set((settings.disabledPhrases || []).map(norm));
  for (const p of DEFAULT_PHRASES) { const n = norm(p); if (!off.has(n) && t.includes(' ' + n + ' ')) hits.push({ phrase: p, custom: false }); }
  for (const p of settings.customKeywords || []) { const n = norm(p); if (n && t.includes(' ' + n + ' ')) hits.push({ phrase: p, custom: true }); }
  return hits;
}

export class SpeechMonitor {
  /**
   * @param {object} o {lang, settings, getTime:()=>seconds, onResult(seg), onError(msg), onState(state)}
   */
  constructor(o) { this.o = o; this.running = false; this.rec = null; this.lastFinalAt = 0; }
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.o.onError?.('Speech recognition is not supported in this browser.'); return false; }
    this.running = true; this._spawn(SR); return true;
  }
  _spawn(SR) {
    const r = new SR(); this.rec = r;
    r.lang = this.o.lang || 'en-US'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]; const text = res[0].transcript.trim(); if (!text) continue;
        const t = this.o.getTime();
        const hits = matchKeywords(text, this.o.settings());
        this.o.onResult({ t, text, final: res.isFinal, confidence: res[0].confidence || 0, hits });
      }
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      const msg = { 'not-allowed': 'Microphone permission was denied, so speech detection is off.', 'service-not-allowed': 'The browser blocked its speech service.', network: 'Speech recognition needs a network connection in this browser (it is not guaranteed offline).', 'audio-capture': 'No microphone found for speech recognition.' }[e.error] || 'Speech recognition error: ' + e.error;
      this.o.onError?.(msg);
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) this.running = false;
    };
    r.onend = () => { if (this.running) { try { this._spawn(SR); } catch { this.running = false; this.o.onState?.('stopped'); } } else this.o.onState?.('stopped'); };
    try { r.start(); this.o.onState?.('listening'); } catch (err) { this.o.onError?.('Could not start speech recognition: ' + err.message); this.running = false; }
  }
  stop() { this.running = false; try { this.rec?.stop(); } catch {} }
}
