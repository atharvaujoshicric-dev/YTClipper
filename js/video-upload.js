// Upload Recording: drag & drop, validation, metadata probing, preview and project creation.
import { h, icon, fmtBytes, fmtTime, fmtDur, toast, loadVideo, disposeVideo, once, UrlManager, uid } from './utils.js';
import { state, newProject, attachMedia, saveProject, setCurrentProject, addHistory } from './state.js';
import { grabFrame } from './visual-analyzer.js';
import { analyzeProject } from './analyze.js';

export const RIGHTS_TEXT = 'I own this footage, or I have explicit permission to capture and republish it (including any music, voices and third-party content in it).';
const OK_EXT = /\.(mp4|m4v|mov|webm)$/i;

export function rightsNotice() {
  return h('div', { class: 'rights small' }, h('b', {}, 'Viewing is not republishing. '), 'Being able to watch or record a stream does not give you the right to repost it. ClipForge only processes footage you own or are authorised to republish, never bypasses DRM or protected streams, and does not download videos from URLs. You remain responsible for platform rules and copyright (including game publisher content guidelines).');
}

export async function probeVideo(file) {
  const info = { name: file.name, size: file.size, type: file.type, ok: false, errors: [], warnings: [], duration: 0, width: 0, height: 0, fps: null, hasAudio: null, thumb: null };
  if (!OK_EXT.test(file.name) && !/^video\/(mp4|webm|quicktime)$/.test(file.type)) { info.errors.push(`“${file.name}” is not a supported format. Use MP4, WebM or MOV.`); return info; }
  if (file.size === 0) { info.errors.push('The file is empty.'); return info; }
  const urls = new UrlManager(); let v;
  try {
    const url = urls.create(file); v = await loadVideo(url, { timeout: 20000 });
    info.duration = v.duration; info.width = v.videoWidth; info.height = v.videoHeight;
    if (!info.width || !info.height) { info.errors.push('This browser decoded the container but found no video track (the video codec may be unsupported, e.g. HEVC/H.265 in some browsers).'); return info; }
    if (!isFinite(info.duration) || info.duration <= 0) { info.errors.push('Could not read the video duration — the file may be truncated or corrupt.'); return info; }
    if (typeof v.mozHasAudio === 'boolean') info.hasAudio = v.mozHasAudio; else if (v.audioTracks) info.hasAudio = v.audioTracks.length > 0;
    // frame rate + audio-decode probe by briefly playing muted
    try {
      await v.play(); const times = [];
      await new Promise((res) => {
        const stop = setTimeout(res, 1200);
        if (v.requestVideoFrameCallback) { const cb = (_, m) => { times.push(m.mediaTime); if (times.length < 14) v.requestVideoFrameCallback(cb); else { clearTimeout(stop); res(); } }; v.requestVideoFrameCallback(cb); }
      });
      if (times.length > 3) { const d = (times[times.length - 1] - times[0]) / (times.length - 1); if (d > 0) info.fps = Math.round(1 / d); }
      if (info.hasAudio == null && 'webkitAudioDecodedByteCount' in v && v.webkitAudioDecodedByteCount > 0) info.hasAudio = true;
      v.pause();
    } catch {}
    info.thumb = await grabFrame(v, Math.min(info.duration * 0.1, info.duration - 0.1)).catch(() => null);
    if (file.size > 1.5 * 1024 ** 3) info.warnings.push(`Very large file (${fmtBytes(file.size)}). It will stay in memory for this session only, and audio is analysed in real time (slower).`);
    else if (file.size > 600 * 1048576) info.warnings.push(`Large file (${fmtBytes(file.size)}). Analysis may take a while and use significant memory.`);
    if (info.duration > 3 * 3600) info.warnings.push('Recordings over 3 hours may be slow to analyse.');
    if (info.hasAudio === false) info.warnings.push('No audio track detected — audio and reaction signals will be unavailable.');
    info.ok = true;
  } catch (e) {
    info.errors.push(`This browser cannot decode “${file.name}”. ${/codec|decode|format|src/i.test(e.message) ? '' : e.message + ' '}Try re-exporting as H.264/AAC MP4 or VP9/Opus WebM.`);
  } finally { if (v) disposeVideo(v); urls.revokeAll(); }
  return info;
}

export function mountUpload(root, { onAdded } = {}) {
  const pending = []; const urls = new UrlManager();
  const list = h('div', { class: 'stack' });
  const rights = h('input', { type: 'checkbox', id: 'rights-upload', onchange: refresh });
  const input = h('input', { type: 'file', multiple: true, accept: 'video/mp4,video/webm,video/quicktime,.mp4,.m4v,.mov,.webm', class: 'hidden', onchange: (e) => addFiles([...e.target.files]) });
  const dz = h('div', { class: 'dropzone', tabindex: 0, role: 'button', 'aria-label': 'Upload recordings', onclick: () => input.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); } },
    icon('upload'), h('h3', {}, 'Drop gameplay recordings here'), h('p', { class: 'muted' }, 'or click to choose files · MP4, WebM or MOV · multiple files supported'), input);
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
  const bar = h('div', { class: 'row hidden' });
  const addBtn = h('button', { class: 'btn', onclick: () => commit(false) }, icon('check', 'sm'), 'Add to library');
  const addGo = h('button', { class: 'btn primary', onclick: () => commit(true) }, icon('spark', 'sm'), 'Add & analyse');
  bar.append(h('label', { class: 'check', style: { flex: 1, minWidth: '260px' } }, rights, h('span', {}, RIGHTS_TEXT)), addBtn, addGo);

  root.append(h('div', { class: 'card pad stack' }, dz, list, bar, rightsNotice()));

  async function addFiles(files) {
    for (const f of files) {
      const row = { id: uid('up'), file: f, name: f.name.replace(/\.[^.]+$/, ''), info: null };
      pending.push(row); renderRow(row, true);
      row.info = await probeVideo(f); renderRow(row); refresh();
      if (!row.info.ok) toast(row.info.errors[0], 'error', 8000);
    }
    input.value = '';
  }
  function renderRow(row, loading = false) {
    let el = list.querySelector(`[data-id="${row.id}"]`);
    const n = h('div', { class: 'file-row', dataset: { id: row.id } });
    const i = row.info;
    if (loading || !i) n.append(h('div', { class: 'skeleton', style: { width: '120px', aspectRatio: '16/9' } }), h('div', {}, h('b', {}, row.file.name), h('div', { class: 'muted small' }, 'Reading metadata…')), h('span', { class: 'spinner' }));
    else {
      const preview = i.ok ? h('video', { src: urls.create(row.file), controls: true, muted: true, preload: 'metadata', playsinline: true, poster: i.thumb || '' }) : h('div', { class: 'thumb', style: { width: '120px' } });
      n.append(preview, h('div', { class: 'stack', style: { gap: '6px', minWidth: 0 } },
        h('div', { class: 'row' }, i.ok ? h('input', { type: 'text', value: row.name, 'aria-label': 'Project name', style: { maxWidth: '320px' }, oninput: (e) => (row.name = e.target.value) }) : h('b', {}, row.file.name), i.ok ? h('span', { class: 'tag green' }, 'Ready') : h('span', { class: 'tag red' }, 'Rejected')),
        i.ok ? h('div', { class: 'meta-grid' },
          ...[['Size', fmtBytes(i.size)], ['Duration', fmtTime(i.duration)], ['Resolution', `${i.width}×${i.height}`], ['Frame rate', i.fps ? i.fps + ' fps' : 'n/a'], ['Audio', i.hasAudio === true ? 'Detected' : i.hasAudio === false ? 'None' : 'Checked at analysis'], ['Format', (i.type || 'video').replace('video/', '').toUpperCase()]].map(([k, v]) => h('div', {}, h('span', {}, k), h('b', {}, v)))) : null,
        ...i.errors.map((e) => h('div', { class: 'notice err small' }, icon('warn', 'sm'), e)), ...i.warnings.map((w) => h('div', { class: 'notice warn small' }, icon('warn', 'sm'), w))),
        h('button', { class: 'btn sm icon', 'aria-label': 'Remove', onclick: () => { pending.splice(pending.indexOf(row), 1); n.remove(); refresh(); } }, icon('x', 'sm')));
    }
    el ? el.replaceWith(n) : list.append(n);
  }
  function refresh() {
    const ready = pending.filter((p) => p.info?.ok);
    bar.classList.toggle('hidden', !pending.length);
    const can = ready.length && rights.checked; addBtn.classList.toggle('disabled', !can); addGo.classList.toggle('disabled', !can);
    addBtn.disabled = addGo.disabled = !can;
    addBtn.title = can ? '' : ready.length ? 'Confirm you have the rights to this footage first' : 'No valid files';
  }
  async function commit(analyse) {
    const ready = pending.filter((p) => p.info?.ok); if (!ready.length || !rights.checked) return;
    const created = [];
    for (const row of ready) {
      const i = row.info;
      try {
        const p = newProject({ name: row.name.trim() || row.file.name, source: 'upload', filename: row.file.name, size: i.size, mime: row.file.type, duration: i.duration, width: i.width, height: i.height, fps: i.fps, hasAudio: i.hasAudio, thumb: i.thumb, rights: true, rightsAt: Date.now(), status: 'new', stats: { highlights: 0 } });
        await attachMedia(p, row.file); created.push(p);
        await addHistory('import', 'success', `Imported ${row.file.name} (${fmtBytes(i.size)})`, p);
        if (!p.mediaStored) toast(`“${p.name}” is held in memory only (larger than the storage limit or storage is full). Re-link it after a reload.`, 'warn', 8000);
      } catch (e) { toast('Could not add ' + row.file.name + ': ' + e.message, 'error', 8000); }
    }
    pending.length = 0; list.innerHTML = ''; urls.revokeAll(); rights.checked = false; refresh();
    if (created.length) { setCurrentProject(created[0].id); toast(`${created.length} recording(s) added.`, 'success'); onAdded?.(created); if (analyse) { for (const p of created) await analyzeProject(p); } }
  }
  return () => urls.revokeAll();
}
