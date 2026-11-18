// Vertical conversion layouts. Never stretches footage. Static crop position only — no subject tracking is implemented.
import { clamp } from './utils.js';
import { STEP } from './engagement-scorer.js';

export const SAFE = { top: 0.1, bottom: 0.22, left: 0.06, right: 0.14 }; // fractions reserved for Reels / Shorts UI
export const CROP_MODES = {
  center: { label: 'Center crop', desc: 'Fills 9:16 from the centre of the frame.' },
  adjustable: { label: 'Adjustable crop', desc: 'Same fill, but you choose the horizontal position (static — not subject tracking).' },
  original: { label: 'Original aspect', desc: 'Whole frame, letterboxed on black. Nothing is cropped.' },
  blur: { label: 'Blurred background', desc: 'Whole frame over a blurred, zoomed copy of itself.' },
};

export function computeLayout(mode, sw, sh, ow, oh, cropX = 0.5, zoom = 1) {
  const L = { mode, ow, oh };
  const cover = (cx) => {
    const ar = ow / oh; let cw = sh * ar, ch = sh; if (cw > sw) { cw = sw; ch = sw / ar; }
    cw /= zoom; ch /= zoom;
    const sx = clamp(cx * sw - cw / 2, 0, sw - cw), sy = (sh - ch) / 2;
    return { sx, sy, sw: cw, sh: ch, dx: 0, dy: 0, dw: ow, dh: oh };
  };
  if (mode === 'original' || mode === 'blur') {
    const dh = (sh * ow) / sw; L.fg = { sx: 0, sy: 0, sw, sh, dx: 0, dy: (oh - dh) / 2, dw: ow, dh };
    if (mode === 'blur') L.bg = cover(0.5);
  } else L.fg = cover(mode === 'center' ? 0.5 : clamp(cropX, 0, 1));
  return L;
}

let blurCanvas = null;
export function drawLayout(ctx, video, L) {
  const { ow, oh } = L;
  if (L.mode !== 'center' && L.mode !== 'adjustable') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ow, oh); }
  if (L.bg) {
    if (!blurCanvas) blurCanvas = document.createElement('canvas');
    blurCanvas.width = 36; blurCanvas.height = Math.round(36 * (oh / ow));
    const b = blurCanvas.getContext('2d'); b.drawImage(video, L.bg.sx, L.bg.sy, L.bg.sw, L.bg.sh, 0, 0, blurCanvas.width, blurCanvas.height);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(blurCanvas, 0, 0, ow, oh);
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, ow, oh); ctx.restore();
  }
  const f = L.fg; ctx.drawImage(video, f.sx, f.sy, f.sw, f.sh, f.dx, f.dy, f.dw, f.dh);
}

/** Suggests a static crop centre from where frame-to-frame motion happened (motion energy, NOT subject tracking). */
export function suggestCropX(tl, start, end) {
  const V = tl.visual?.available ? tl.visual : null; if (!V) return 0.5;
  let num = 0, den = 0;
  for (let i = Math.floor(start / STEP); i <= Math.min(V.motion.length - 1, Math.floor(end / STEP)); i++) { const w = V.motion[i]; num += w * V.motionX[i]; den += w; }
  return den > 0 ? clamp(num / den, 0.2, 0.8) : 0.5;
}
