// Video Library: project list, metadata, resume / re-analyse, rename, re-link, delete.
import { h, icon, fmtBytes, fmtDur, fmtTime, fmtDate, toast, confirmDialog, promptDialog, modal, emptyState } from './utils.js';
import { state, setCurrentProject, saveProject, deleteProject, highlightsOf, attachMedia, getMediaBlob } from './state.js';
import { mountUpload } from './video-upload.js';
import { analyzeProject, redetectProject, isAnalyzing } from './analyze.js';
import { bus } from './utils.js';

const STATUS = { new: ['New', ''], analyzing: ['Analysing…', 'orange'], analyzed: ['Analysed', 'green'], interrupted: ['Interrupted — resume', 'orange'], error: ['Error', 'red'], recording: ['Recording', 'red'] };

export function mount(root) {
  const upWrap = h('div', {}); const grid = h('div', { class: 'grid cols-3' });
  root.append(
    h('div', { class: 'view-head fade-in' }, h('div', {}, h('h1', {}, icon('library'), 'Video Library'), h('p', { class: 'sub' }, 'Import authorised gameplay recordings. Videos are processed locally in your browser — nothing is uploaded to a server.'))),
    h('div', { class: 'fade-in', style: { marginBottom: '22px' } }, upWrap), h('div', { class: 'card-head' }, h('h3', {}, 'Projects')), grid);
  const unUp = mountUpload(upWrap, { onAdded: () => draw() });
  const off = [bus.on('change', () => draw()), bus.on('processing', () => draw())];
  draw();
  function draw() {
    grid.innerHTML = '';
    const projects = [...state.projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!projects.length) { grid.className = ''; grid.append(emptyState('library', 'No projects yet', 'Drop a recording above, or start a live capture. Every project, highlight and caption you create is saved in this browser.', [h('a', { class: 'btn', href: '#/live' }, icon('live', 'sm'), 'Start live capture')])); return; }
    grid.className = 'grid cols-3';
    for (const p of projects) {
      const hls = highlightsOf(p.id); const exp = state.exportsLog.filter((e) => e.projectId === p.id && e.status === 'done').length;
      const [st, cls] = STATUS[p.status] || ['—', ''];
      const needsRelink = !p.mediaStored && !state.sessionFiles.has(p.id);
      grid.append(h('div', { class: 'card proj-card fade-in' + (p.id === state.currentProjectId ? ' current' : '') },
        h('div', { class: 'cover', style: { backgroundImage: p.thumb ? `url(${p.thumb})` : 'none' } }, h('div', { class: 'tags' }, h('span', { class: 'tag ' + cls }, st), p.source === 'live' ? h('span', { class: 'tag red' }, 'Live capture') : null)),
        h('div', { class: 'body' },
          h('h3', { title: p.name }, p.name),
          h('div', { class: 'pc-stats' }, h('span', {}, h('b', {}, fmtTime(p.duration)), ' long'), h('span', {}, h('b', {}, fmtBytes(p.size))), h('span', {}, h('b', {}, hls.length), ' highlights'), h('span', {}, h('b', {}, exp), ' exported')),
          h('div', { class: 'small dim' }, 'Added ' + fmtDate(p.createdAt)),
          p.error ? h('div', { class: 'notice err small' }, icon('warn', 'sm'), p.error) : null,
          needsRelink ? h('div', { class: 'notice warn small' }, icon('warn', 'sm'), 'Source video is not in memory or storage. Re-link the original file to preview, analyse or export.') : null,
          h('div', { class: 'pc-actions' },
            h('button', { class: 'btn sm primary', onclick: () => { setCurrentProject(p.id); location.hash = '#/highlights'; } }, 'Open'),
            needsRelink ? h('button', { class: 'btn sm', onclick: () => relink(p) }, icon('upload', 'sm'), 'Re-link video')
              : p.status === 'analyzed' ? h('button', { class: 'btn sm', disabled: isAnalyzing(), onclick: async () => { setCurrentProject(p.id); await redetectProject(p); } }, 'Re-run detection')
              : h('button', { class: 'btn sm', disabled: isAnalyzing() || p.source === 'live', onclick: () => { setCurrentProject(p.id); analyzeProject(p); } }, p.status === 'interrupted' ? 'Resume processing' : 'Analyse'),
            p.status === 'analyzed' && !needsRelink && p.source !== 'live' ? h('button', { class: 'btn sm ghost', disabled: isAnalyzing(), onclick: () => { setCurrentProject(p.id); analyzeProject(p); } }, 'Full re-analysis') : null,
            h('button', { class: 'btn sm ghost', onclick: () => meta(p) }, 'Metadata'),
            h('button', { class: 'btn sm ghost icon', 'aria-label': 'Rename', 'data-tip': 'Rename', onclick: async () => { const n = await promptDialog('Rename project', 'Project name', p.name); if (n) { p.name = n; await saveProject(p); } } }, icon('edit', 'sm')),
            h('button', { class: 'btn sm danger icon', 'aria-label': 'Delete', 'data-tip': 'Delete project', onclick: async () => { if (await confirmDialog('Delete this project?', `“${p.name}”, its stored video, analysis data, ${hls.length} highlight(s) and export history will be permanently removed from this browser. Files you already downloaded are not affected.`, { okText: 'Delete project', danger: true })) { await deleteProject(p.id); toast('Project deleted.', 'success'); } } }, icon('trash', 'sm'))))));
    }
  }
  function relink(p) {
    const inp = h('input', { type: 'file', accept: 'video/*,.mp4,.mov,.webm,.m4v', onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size !== p.size && !(await confirmDialog('File differs from the original', `Original: ${p.filename || p.name} (${fmtBytes(p.size)}). Selected: ${f.name} (${fmtBytes(f.size)}). Highlight timestamps only match the original recording. Link it anyway?`, { okText: 'Link anyway' }))) return;
      p.needsRelink = false; await attachMedia(p, f); toast('Video linked.', 'success');
    } });
    inp.click();
  }
  function meta(p) {
    const rows = [['Project ID', p.id], ['File name', p.filename || '—'], ['Source', p.source === 'live' ? 'Live screen capture' : 'Uploaded file'], ['Format', p.mime || '—'], ['Size', fmtBytes(p.size)], ['Duration', fmtDur(p.duration) + ` (${fmtTime(p.duration)})`], ['Resolution', p.width ? `${p.width}×${p.height}` : '—'], ['Frame rate', p.fps ? p.fps + ' fps' : 'n/a'], ['Audio track', p.hasAudio == null ? 'unknown' : p.hasAudio ? 'yes' : 'no'], ['Stored in browser', p.mediaStored ? 'yes (IndexedDB)' : 'no — session only'], ['Added', fmtDate(p.createdAt)], ['Analysed', p.analyzedAt ? fmtDate(p.analyzedAt) : '—'], ['Rights confirmed', p.rights ? 'yes ' + (p.rightsAt ? fmtDate(p.rightsAt) : '') : 'no'], ['Audio analysis', p.analysisInfo?.audio ? (p.analysisInfo.audio.available ? 'ok (' + p.analysisInfo.audio.method + ')' : 'unavailable — ' + p.analysisInfo.audio.reason) : '—'], ['Visual analysis', p.analysisInfo?.visual ? 'ok' : '—'], ['Speech analysis', p.analysisInfo?.speech ? (p.analysisInfo.speech.available ? 'ok' : 'unavailable — ' + p.analysisInfo.speech.reason) : '—']];
    modal({ title: 'Recording metadata', body: h('table', { class: 'tbl' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', { class: 'muted' }, k), h('td', {}, v))))) });
  }
  return () => { unUp(); off.forEach((f) => f()); };
}
