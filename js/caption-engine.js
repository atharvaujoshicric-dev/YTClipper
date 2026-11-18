// Captions: model, SRT/VTT import-export, text splitting and canvas rendering (burned-in).
import { clamp, uid } from './utils.js';
import { SAFE } from './crop-engine.js';

export const THEMES = {
  white: { fill: '#ffffff', hi: '#ffe14a', name: 'White' },
  yellow: { fill: '#ffe14a', hi: '#ffffff', name: 'Yellow' },
};
export const newCaption = (start, end, text = '') => ({ id: uid('c'), start: +start.toFixed(2), end: +end.toFixed(2), text });

export function activeCaption(caps, t) { return (caps || []).find((c) => t >= c.start && t < c.end) || null; }

/** Split free text into readable caption chunks spread evenly over [start,end]. */
export function captionsFromText(text, start, end, maxWords = 6) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean); if (!words.length) return [];
  const chunks = []; for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(' '));
  const per = (end - start) / chunks.length;
  return chunks.map((c, i) => newCaption(start + i * per, start + (i + 1) * per, c));
}

const pad = (n, l = 2) => String(Math.floor(n)).padStart(l, '0');
function tcode(sec, sep) { const h = sec / 3600, m = (sec % 3600) / 60, s = sec % 60; return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad((sec % 1) * 1000, 3)}`; }
export const toSRT = (caps, offset = 0) => caps.map((c, i) => `${i + 1}\n${tcode(Math.max(0, c.start - offset), ',')} --> ${tcode(Math.max(0, c.end - offset), ',')}\n${c.text}\n`).join('\n');
export const toVTT = (caps, offset = 0) => 'WEBVTT\n\n' + caps.map((c) => `${tcode(Math.max(0, c.start - offset), '.')} --> ${tcode(Math.max(0, c.end - offset), '.')}\n${c.text}\n`).join('\n');

/** Parse SRT or VTT. Times are returned as in the file; caller adds a clip offset if needed. */
export function parseSubtitles(text) {
  const out = []; const re = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g; let m;
  const t = (h, mi, s, ms) => +h * 3600 + +mi * 60 + +s + +ms.padEnd(3, '0') / 1000;
  while ((m = re.exec(text.replace(/\r/g, '')))) out.push(newCaption(t(m[1], m[2], m[3], m[4]), t(m[5], m[6], m[7], m[8]), m[9].replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim()));
  return out;
}

function wrap(ctx, words, maxW) {
  const lines = []; let line = [];
  for (const w of words) {
    const test = [...line, w].map((x) => x.text).join(' ');
    if (line.length && ctx.measureText(test).width > maxW) { lines.push(line); line = [w]; } else line.push(w);
  }
  if (line.length) lines.push(line);
  return lines;
}

/** Draw the active caption (if any). W/H are the output canvas size; style.size is in px at 1080-wide output. */
export function drawCaption(ctx, caps, srcTime, style, W, H) {
  const cap = activeCaption(caps, srcTime); if (!cap || !cap.text.trim()) return;
  const th = THEMES[style.theme] || THEMES.white; const scale = W / 1080; const size = Math.round((style.size || 64) * scale);
  ctx.save();
  ctx.font = `800 ${size}px Inter, "Segoe UI", Arial, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const words = cap.text.trim().split(/\s+/).map((t) => ({ text: t.toUpperCase() }));
  const maxW = W * (1 - SAFE.left - SAFE.right) - size * 0.6;
  const lines = wrap(ctx, words, maxW); const lh = size * 1.22; const blockH = lines.length * lh;
  const prog = clamp((srcTime - cap.start) / Math.max(0.01, cap.end - cap.start), 0, 0.999);
  const hiIdx = style.highlight ? Math.floor(prog * words.length) : -1;
  const cx = (W * (SAFE.left + (1 - SAFE.right))) / 2; // centred inside the safe area
  let cy = (style.y ?? 0.7) * H; cy = clamp(cy, SAFE.top * H + blockH / 2, (1 - SAFE.bottom) * H - blockH / 2);
  if (style.box) {
    const widest = Math.max(...lines.map((l) => ctx.measureText(l.map((w) => w.text).join(' ')).width));
    ctx.fillStyle = 'rgba(0,0,0,.62)'; const pad_ = size * 0.35;
    const x = cx - widest / 2 - pad_, y = cy - blockH / 2 - pad_ * 0.6, w = widest + pad_ * 2, hh = blockH + pad_ * 1.2, r = size * 0.28;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, hh, r) : ctx.rect(x, y, w, hh); ctx.fill();
  }
  let wi = 0; const space = ctx.measureText(' ').width;
  lines.forEach((line, li) => {
    const lw = line.reduce((a, w) => a + ctx.measureText(w.text).width, 0) + space * (line.length - 1);
    let x = cx - lw / 2; const y = cy - blockH / 2 + lh * li + lh / 2;
    for (const w of line) {
      const ww = ctx.measureText(w.text).width;
      if (style.outline) { ctx.lineWidth = Math.max(4, size * 0.16); ctx.strokeStyle = '#000'; ctx.strokeText(w.text, x, y); }
      ctx.fillStyle = wi === hiIdx ? th.hi : th.fill; ctx.fillText(w.text, x, y);
      x += ww + space; wi++;
    }
  });
  ctx.restore();
}

/** Free text overlay (hook text, titles). Times (outStart/outEnd) are in OUTPUT seconds; null = whole clip. */
export function drawOverlay(ctx, ov, outTime, W, H) {
  if (!ov.text) return;
  if (ov.outStart != null && outTime < ov.outStart) return; if (ov.outEnd != null && outTime > ov.outEnd) return;
  const scale = W / 1080, size = Math.round((ov.size || 72) * scale);
  ctx.save(); ctx.font = `900 ${size}px Inter, "Segoe UI", Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const words = ov.text.split(/\s+/).map((t) => ({ text: t.toUpperCase() }));
  const lines = wrap(ctx, words, W * 0.84).map((l) => l.map((w) => w.text).join(' '));
  const lh = size * 1.18; const cx = (ov.x ?? 0.5) * W; let cy = (ov.y ?? 0.2) * H; cy = clamp(cy, SAFE.top * H + (lines.length * lh) / 2, (1 - SAFE.bottom) * H - (lines.length * lh) / 2);
  if (ov.box) { const widest = Math.max(...lines.map((l) => ctx.measureText(l).width)); ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(cx - widest / 2 - 16 * scale, cy - (lines.length * lh) / 2 - 8 * scale, widest + 32 * scale, lines.length * lh + 16 * scale); }
  lines.forEach((l, i) => {
    const y = cy - (lines.length * lh) / 2 + lh * i + lh / 2;
    if (ov.shadow) { ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = size * 0.25; ctx.shadowOffsetY = size * 0.06; }
    if (ov.outline) { ctx.lineWidth = Math.max(4, size * 0.16); ctx.strokeStyle = '#000'; ctx.strokeText(l, cx, y); }
    ctx.fillStyle = ov.color || '#fff'; ctx.fillText(l, cx, y); ctx.shadowColor = 'transparent';
  });
  ctx.restore();
}
