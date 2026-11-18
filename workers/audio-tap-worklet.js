// AudioWorklet that forwards mono PCM blocks to the main thread for live analysis.
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const L = ch[0], R = ch[1] || ch[0];
      for (let i = 0; i < L.length; i++) {
        this.buf[this.n++] = (L[i] + R[i]) * 0.5;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('clipforge-tap', Tap);
