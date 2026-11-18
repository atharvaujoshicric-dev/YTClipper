// Single compositing path used by the editor preview AND the exporter (what you see is what is rendered).
import { computeLayout, drawLayout, SAFE } from './crop-engine.js';
import { drawCaption, drawOverlay } from './caption-engine.js';

export function renderFrame(ctx, video, hl, srcTime, outTime, W, H, { safeGuides = false } = {}) {
  const vw = video.videoWidth || 1920, vh = video.videoHeight || 1080;
  const L = computeLayout(hl.crop?.mode || 'center', vw, vh, W, H, hl.crop?.x ?? 0.5, hl.crop?.zoom || 1);
  if (video.readyState >= 2) drawLayout(ctx, video, L); else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
  if (hl.captionsEnabled) drawCaption(ctx, hl.captions, srcTime, hl.captionStyle || {}, W, H);
  for (const ov of hl.overlays || []) drawOverlay(ctx, ov, outTime, W, H);
  if (safeGuides) {
    ctx.save(); ctx.strokeStyle = 'rgba(255,74,54,.8)'; ctx.setLineDash([10, 8]); ctx.lineWidth = 3;
    ctx.strokeRect(W * SAFE.left, H * SAFE.top, W * (1 - SAFE.left - SAFE.right), H * (1 - SAFE.top - SAFE.bottom)); ctx.restore();
  }
}
