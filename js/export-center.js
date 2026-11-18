// Social Media Export Center: queue, progress, verification, per-platform metadata, individual / bulk ZIP download.
import { h, icon, fmtBytes, fmtTime, fmtDur, toast, emptyState, scoreBadge, downloadBlob, safeName, uid, bus, confirmDialog } from './utils.js';
import { state, saveHighlight, saveHighlights, logExport, addHistory, getTimeline, setProcessing, endProcessing } from './state.js';
import { exportClip, suggestContent, makeZip, makeCover, exportCapabilities, ffmpegStatus, initFFmpeg } from './export-engine.js';
import { segmentsOf, outDuration } from './hook-intelligence.js';
import { exportSelection } from './highlights.js';

// The queue lives at module level so exports keep running while you browse other pages.
const queue = []; let running = false; let abortCtl = null;
export const queueState = () => ({ running, jobs: queue });

/** Queue one clip from outside the Export Center (used by Live Clipper auto-export). */
export function enqueueClip(hl) {
  const prior = queue.find((j) => j.hlId === hl.id && ['queued', 'rendering', 'encoding', 'verifying'].includes(j.status)); if (prior) return prior;
  const job = { id: uid('job'), hlId: hl.id, projectId: hl.projectId, title: hl.title, thumb: hl.thumb, status: 'queued', stage: 'Queued', progress: 0, coverTime: hl.coverTime ?? hl.peak };
  queue.push(job); bus.emit('exportq'); runQueue(); return job;
}
export const jobFor = (hlId) => queue.find((j) => j.hlId === hlId);
export const downloadJob = (j) => downloadBlob(j.result.blob, j.filename);
function filenameFor(job, ext) { return `${safeName(job.title)}_${job.hlId.slice(-5)}.${ext}`; }

async function runQueue() {
  if (running) return; running = true; bus.emit('exportq');
  try {
    for (const job of queue) {
      if (job.status !== 'queued') continue;
      const hl = state.highlights.get(job.hlId), proj = hl && state.projects.get(hl.projectId);
      if (!hl || !proj) { job.status = 'failed'; job.error = 'Highlight or project no longer exists.'; continue; }
      abortCtl = new AbortController(); job.status = 'rendering'; job.stage = 'Rendering'; job.progress = 0; job.error = null; bus.emit('exportq');
      setProcessing({ active: true, label: `Exporting “${hl.title}”`, pct: 0, cancel: () => abortCtl?.abort(), error: null });
      const t0 = performance.now();
      try {
        const run = () => exportClip(hl, proj, { resolution: state.settings.exportResolution, format: state.settings.exportFormat, fps: state.settings.exportFps || 30, coverTime: job.coverTime }, {
          signal: abortCtl.signal, onStage: (s) => { job.stage = s; job.status = s === 'Verifying' ? 'verifying' : s.startsWith('Encoding') ? 'encoding' : 'rendering'; bus.emit('exportq'); },
          onProgress: (p) => { job.progress = p; setProcessing({ pct: Math.round(p * 100) }); bus.emit('exportq'); } });
        let res; try { res = await run(); } catch (e1) { if (e1.name === 'AbortError') throw e1; console.warn('export failed once, retrying', e1); job.stage = 'Retrying'; bus.emit('exportq'); await new Promise((r) => setTimeout(r, 1500)); res = await run(); }
        job.result = res; job.status = 'done'; job.stage = 'Done'; job.progress = 1; job.filename = filenameFor(job, res.ext);
        hl.exportedCount = (hl.exportedCount || 0) + 1; await saveHighlight(hl);
        await logExport({ id: job.id, projectId: proj.id, highlightId: hl.id, title: hl.title, status: 'done', ts: Date.now(), size: res.blob.size, format: res.ext, width: res.width, height: res.height, duration: res.duration, warnings: res.warnings, ms: Math.round(performance.now() - t0) });
        await addHistory('export', 'success', `Exported “${hl.title}” (${res.ext.toUpperCase()}, ${fmtBytes(res.blob.size)})`, proj);
        if (res.warnings.length) toast(res.warnings[0], 'warn', 8000);
      } catch (e) {
        if (e.name === 'AbortError') { job.status = 'cancelled'; job.error = 'Cancelled'; }
        else { console.error(e); job.status = 'failed'; job.error = e.message; await logExport({ id: job.id, projectId: proj.id, highlightId: hl.id, title: hl.title, status: 'failed', ts: Date.now(), error: e.message }); await addHistory('export', 'failed', `“${hl.title}”: ${e.message}`, proj); toast(`Export failed for “${hl.title}”: ${e.message}`, 'error', 9000); }
      }
      bus.emit('exportq');
      if (job.status === 'cancelled') { queue.filter((j) => j.status === 'queued').forEach((j) => (j.status = 'cancelled')); break; }
    }
  } finally { running = false; abortCtl = null; endProcessing(queue.some((j) => j.status === 'failed') ? 'Export finished with errors' : 'Export complete'); bus.emit('exportq'); }
}

function ensureMeta(hl, proj, tl) {
  if (!hl.meta?.title) { const s = suggestContent(hl, proj, tl); hl.meta = { title: s.title, reelsCaption: s.reelsCaption, shortsDescription: s.shortsDescription, hashtags: s.hashtags, keywords: s.keywords, suggest: s }; }
  else hl.meta.suggest = suggestContent(hl, proj, tl);
  return hl.meta;
}

export async function mount(root) {
  const caps = exportCapabilities();
  const approved = [...state.highlights.values()].filter((x) => x.status === 'approved').sort((a, b) => b.score - a.score);
  const sel = new Set([...exportSelection].filter((id) => state.highlights.get(id)?.status === 'approved')); if (!sel.size) approved.forEach((x) => sel.add(x.id));
  const jobsBox = h('div', { class: 'stack' }); const clipsBox = h('div', { class: 'stack' }); const histBox = h('div', {});
  const ffInfo = h('span', { class: 'small muted' });
  const capNote = () => {
    const f = ffmpegStatus(); const fmt = state.settings.exportFormat;
    if (!caps.recorder) return h('div', { class: 'notice err' }, icon('warn'), 'This browser cannot record canvas video, so export is unavailable. Use a current desktop Chrome, Edge or Firefox.');
    if (fmt === 'webm') return h('div', { class: 'notice' }, icon('help'), 'Export format is WebM (Settings). WebM uploads fine to YouTube Shorts; Instagram prefers MP4.');
    if (caps.nativeMp4) return h('div', { class: 'notice ok' }, icon('check'), 'Your browser can record MP4 (H.264 + AAC) natively — no FFmpeg download needed.');
    return h('div', { class: 'notice warn' }, icon('warn'), `This browser records WebM only. MP4 is produced by transcoding with FFmpeg.wasm (≈31 MB download, slower). Status: ${f.state}. If FFmpeg cannot load you receive WebM instead — clearly marked.`);
  };
  root.append(
    h('div', { class: 'view-head fade-in' }, h('div', {}, h('h1', {}, icon('export'), 'Export Center'), h('p', { class: 'sub' }, 'Render approved clips to 9:16 vertical video for Instagram Reels and YouTube Shorts. Files are downloaded to your device — ClipForge never publishes anything for you, and no title, hashtag or clip is guaranteed to perform.')),
      h('div', { class: 'view-actions' }, h('button', { class: 'btn primary', id: 'exp-go', onclick: enqueue }, icon('export', 'sm'), 'Export selected'), h('button', { class: 'btn', onclick: zipAll }, icon('download', 'sm'), 'Download all (ZIP)'))),
    capNote(), h('div', { style: { height: '14px' } }), h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)' } }, h('div', { class: 'stack' }, h('div', { class: 'card-head' }, h('h3', {}, 'Approved clips')), clipsBox), h('div', { class: 'stack' }, h('div', { class: 'card-head' }, h('h3', {}, 'Export queue')), jobsBox, h('div', { class: 'card-head', style: { marginTop: '10px' } }, h('h3', {}, 'Export history')), histBox)));

  const dispose = [bus.on('exportq', drawJobs), bus.on('change', (w) => { if (w === 'exports') drawHist(); })];
  const tlCache = new Map(); const getTL = async (pid) => { if (!tlCache.has(pid)) tlCache.set(pid, await getTimeline(pid)); return tlCache.get(pid); };

  async function drawClips() {
    clipsBox.innerHTML = '';
    if (!approved.length) return clipsBox.append(emptyState('export', 'No approved clips', 'Approve highlights in AI Highlights (or the editor) and they appear here, ready to export.', [h('a', { class: 'btn primary', href: '#/highlights' }, 'Review highlights')]));
    for (const hl of approved) {
      const proj = state.projects.get(hl.projectId); if (!proj) continue; const tl = await getTL(proj.id); const m = ensureMeta(hl, proj, tl); const s = m.suggest;
      const dur = outDuration(segmentsOf(hl)); const coverImg = h('img', { alt: 'Cover frame', style: { width: '70px', aspectRatio: '9/16', objectFit: 'cover', borderRadius: '8px', background: '#000', border: '1px solid var(--line)' } });
      let coverTime = hl.coverTime ?? hl.peak; const lbl = h('span', { class: 'mono small' }, fmtTime(coverTime, true));
      const upd = async () => { const b = await makeCover(hl, proj, coverTime, 270, 480).catch(() => null); if (b) coverImg.src = URL.createObjectURL(b); };
      const f = (label, key, area = false, rows = 3) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), area ? h('textarea', { rows, value: Array.isArray(m[key]) ? m[key].join(' ') : m[key], oninput: (e) => { m[key] = key === 'hashtags' || key === 'keywords' ? e.target.value.split(/[\s,]+/).filter(Boolean) : e.target.value; hl.meta = m; saveHighlight(hl, true); } }, Array.isArray(m[key]) ? m[key].join(' ') : m[key]) : h('input', { type: 'text', value: m[key], oninput: (e) => { m[key] = e.target.value; hl.meta = m; saveHighlight(hl, true); } }));
      clipsBox.append(h('div', { class: 'card pad stack fade-in' },
        h('div', { class: 'row' }, h('input', { type: 'checkbox', checked: sel.has(hl.id), 'aria-label': 'Include in export', onchange: (e) => (e.target.checked ? sel.add(hl.id) : sel.delete(hl.id)) }), scoreBadge(hl.score), h('b', {}, hl.title), h('span', { class: 'tag' }, proj.name), h('span', { class: 'tag' }, fmtDur(dur)), h('span', { class: 'spacer' }), h('a', { class: 'btn sm ghost', href: '#/editor', onclick: () => (state.currentHighlightId = hl.id) }, icon('scissors', 'sm'), 'Edit')),
        !proj.rights ? h('div', { class: 'notice err small' }, icon('warn', 'sm'), 'Rights to republish this footage were not confirmed for this project. Export is blocked.') : null,
        h('div', { class: 'cover-pick' }, coverImg, h('div', { class: 'stack', style: { flex: 1, gap: '6px' } }, h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Cover frame (source time)'), lbl), h('input', { type: 'range', min: hl.start, max: hl.end, step: 0.1, value: coverTime, oninput: (e) => { coverTime = +e.target.value; lbl.textContent = fmtTime(coverTime, true); }, onchange: () => { hl.coverTime = coverTime; saveHighlight(hl, true); upd(); } }), h('div', { class: 'help' }, `Suggested thumbnail: the detected peak (${fmtTime(s.suggestedThumbnailTime)}).`))),
        h('details', { open: false }, h('summary', { class: 'small', style: { cursor: 'pointer' } }, 'Content optimisation & platform metadata'),
          h('div', { class: 'stack', style: { marginTop: '10px' } },
            h('div', { class: 'meta-grid' }, ...[['Best hook', s.bestHook], ['Best duration', s.bestDuration], ['Best opening', s.bestOpening], ['Best caption', s.bestCaption]].map(([k, v]) => h('div', {}, h('span', {}, k), h('b', { style: { fontWeight: 500 } }, v)))),
            h('div', { class: 'tag orange', style: { alignSelf: 'flex-start' } }, 'Instagram Reels'), f('Suggested caption', 'reelsCaption', true, 4),
            h('div', { class: 'tag red', style: { alignSelf: 'flex-start' } }, 'YouTube Shorts'), f('Title (≤100 chars)', 'title'), f('Description', 'shortsDescription', true, 4), f('Hashtags', 'hashtags', true, 2), f('Keywords', 'keywords', true, 2),
            h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => { hl.meta = {}; saveHighlight(hl, true); drawClips(); } }, 'Regenerate suggestions'), h('button', { class: 'btn sm', onclick: () => { navigator.clipboard?.writeText(metaText(hl, m)).then(() => toast('Metadata copied.', 'success', 1800)); } }, 'Copy all')),
            h('div', { class: 'help' }, s.note)))));
      upd();
    }
  }
  const metaText = (hl, m) => `TITLE (YouTube Shorts)\n${m.title}\n\nDESCRIPTION (YouTube Shorts)\n${m.shortsDescription}\n\nCAPTION (Instagram Reels)\n${m.reelsCaption}\n\nHASHTAGS\n${(m.hashtags || []).join(' ')}\n\nKEYWORDS\n${(m.keywords || []).join(', ')}\n`;

  function drawJobs() {
    jobsBox.innerHTML = '';
    if (!queue.length) jobsBox.append(h('div', { class: 'help' }, 'Nothing queued. Tick clips on the left and press “Export selected”. Rendering runs in real time (a 30 s clip takes about 30 s) and the tab should stay visible.'));
    for (const j of queue) {
      jobsBox.append(h('div', { class: 'job ' + j.status },
        h('div', { class: 'thumb v', style: { backgroundImage: j.thumb ? `url(${j.thumb})` : 'none' } }),
        h('div', { class: 'stack', style: { gap: '4px', minWidth: 0 } }, h('b', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, j.title),
          h('div', { class: 'row small' }, h('span', { class: 'tag ' + ({ done: 'green', failed: 'red', cancelled: '', queued: '' }[j.status] || 'orange') }, j.status === 'queued' ? 'Queued' : j.status === 'done' ? 'Verified ✓' : j.status === 'failed' ? 'Failed' : j.status === 'cancelled' ? 'Cancelled' : j.stage), j.result ? h('span', { class: 'muted' }, `${j.result.ext.toUpperCase()} · ${j.result.width}×${j.result.height} · ${fmtBytes(j.result.blob.size)} · ${j.result.verified.duration.toFixed(1)}s`) : null),
          ['rendering', 'encoding', 'verifying'].includes(j.status) ? h('div', { class: 'progress' }, h('i', { style: { width: Math.round(j.progress * 100) + '%' } })) : null,
          j.error && j.status !== 'cancelled' ? h('div', { class: 'small', style: { color: '#ff9a8d' } }, j.error) : null, ...(j.result?.warnings || []).map((w) => h('div', { class: 'small', style: { color: 'var(--amber)' } }, '⚠ ' + w))),
        h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          j.status === 'done' ? h('button', { class: 'btn sm primary', onclick: () => downloadBlob(j.result.blob, j.filename) }, icon('download', 'sm'), 'Download') : null,
          j.status === 'done' && j.result.cover ? h('button', { class: 'btn sm', onclick: () => downloadBlob(j.result.cover, j.filename.replace(/\.\w+$/, '_cover.jpg')) }, 'Cover') : null,
          ['failed', 'cancelled'].includes(j.status) ? h('button', { class: 'btn sm', onclick: () => { j.status = 'queued'; j.error = null; runQueue(); drawJobs(); } }, 'Retry') : null,
          ['rendering', 'encoding', 'verifying'].includes(j.status) ? h('button', { class: 'btn sm danger', onclick: () => abortCtl?.abort() }, 'Cancel') : null,
          !['rendering', 'encoding', 'verifying'].includes(j.status) ? h('button', { class: 'btn sm ghost icon', 'aria-label': 'Remove', onclick: () => { queue.splice(queue.indexOf(j), 1); drawJobs(); } }, icon('x', 'sm')) : null)));
    }
    if (queue.some((j) => j.status === 'queued') && !running) jobsBox.append(h('button', { class: 'btn primary', onclick: runQueue }, 'Start queue'));
  }
  function drawHist() {
    histBox.innerHTML = ''; const rows = state.exportsLog.slice(0, 8);
    if (!rows.length) return histBox.append(h('div', { class: 'help' }, 'No exports yet.'));
    histBox.append(h('div', { class: 'list' }, rows.map((e) => h('div', { class: 'list-item' }, h('span', { class: 'tag ' + (e.status === 'done' ? 'green' : 'red') }, e.status), h('div', { class: 'li-main' }, h('div', { class: 't' }, e.title), h('div', { class: 'm' }, new Date(e.ts).toLocaleString() + (e.size ? ' · ' + fmtBytes(e.size) : '') + (e.error ? ' · ' + e.error : '')))))));
  }

  async function enqueue() {
    const ids = approved.filter((x) => sel.has(x.id)); if (!ids.length) return toast('Tick at least one approved clip.', 'warn');
    if (!caps.recorder) return toast('This browser cannot export video.', 'error');
    for (const hl of ids) {
      const proj = state.projects.get(hl.projectId); if (!proj?.rights) { toast(`“${hl.title}”: rights to republish are not confirmed — skipped.`, 'error', 7000); continue; }
      const prior = queue.find((j) => j.hlId === hl.id && ['queued', 'rendering', 'encoding', 'verifying'].includes(j.status)); if (prior) continue;
      queue.push({ id: uid('job'), hlId: hl.id, projectId: proj.id, title: hl.title, thumb: hl.thumb, status: 'queued', stage: 'Queued', progress: 0, coverTime: hl.coverTime ?? hl.peak });
    }
    drawJobs(); runQueue();
  }
  async function zipAll() {
    const done = queue.filter((j) => j.status === 'done'); if (!done.length) return toast('Export some clips first — the ZIP contains finished, verified exports.', 'warn');
    const files = [];
    for (const j of done) { const hl = state.highlights.get(j.hlId); files.push({ name: j.filename, blob: j.result.blob }); if (j.result.cover) files.push({ name: j.filename.replace(/\.\w+$/, '_cover.jpg'), blob: j.result.cover }); if (hl?.meta?.title) files.push({ name: j.filename.replace(/\.\w+$/, '_metadata.txt'), text: metaText(hl, hl.meta) }); }
    toast('Building ZIP…', 'info', 1500); downloadBlob(await makeZip(files), `clipforge-export-${new Date().toISOString().slice(0, 10)}.zip`);
  }

  drawJobs(); drawHist(); await drawClips();
  return () => dispose.forEach((f) => f());
}
