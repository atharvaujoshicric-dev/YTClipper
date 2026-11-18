// Central in-memory store backed by IndexedDB. All views read from here; all writes go through here.
import { db, storageEstimate, requestPersistence } from './storage.js';
import { bus, uid, UrlManager, toast } from './utils.js';
import { DEFAULTS, mergeSettings } from './settings.js';

export const state = {
  settings: { ...DEFAULTS },
  prefs: { category: {}, hook: { A: { up: 0, down: 0 }, B: { up: 0, down: 0 }, C: { up: 0, down: 0 } }, feedbackCount: 0 },
  projects: new Map(),
  highlights: new Map(),
  exportsLog: [],
  history: [],
  perf: [],
  currentProjectId: null,
  currentHighlightId: null,
  processing: { active: false, label: 'Idle', pct: 0, cancel: null, error: null },
  storage: { usage: 0, quota: 0 },
  sessionFiles: new Map(), // projectId -> File/Blob (not persisted when too large)
  dbError: null,
};

const urls = new UrlManager();
const urlCache = new Map(); // projectId -> url

export async function loadAll() {
  try {
    const [settingsRow, prefsRow, projects, highlights, exportsLog, history, perf] = await Promise.all([
      db.get('settings', 'settings'), db.get('settings', 'prefs'), db.getAll('projects'), db.getAll('highlights'),
      db.getAll('exports'), db.getAll('history'), db.getAll('perf'),
    ]);
    state.settings = mergeSettings(settingsRow?.value);
    if (prefsRow?.value) state.prefs = { ...state.prefs, ...prefsRow.value };
    projects.forEach((p) => {
      // A project left in "analyzing" by a closed tab is resumable, not stuck.
      if (p.status === 'analyzing') { p.status = 'interrupted'; }
      state.projects.set(p.id, p);
    });
    highlights.forEach((x) => state.highlights.set(x.id, x));
    state.exportsLog = exportsLog.sort((a, b) => b.ts - a.ts);
    state.history = history.sort((a, b) => b.ts - a.ts).slice(0, 200);
    state.perf = perf;
    const cur = localStorage.getItem('clipforge.currentProject');
    state.currentProjectId = state.projects.has(cur) ? cur : [...state.projects.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null;
  } catch (e) {
    state.dbError = e;
    console.error('Storage init failed', e);
  }
  refreshStorage();
}

export async function refreshStorage() {
  const est = await storageEstimate();
  state.storage = est; bus.emit('storage', est); return est;
}

export function changed(what = 'all') { bus.emit('change', what); }

export async function saveSettings(patch, replace = false) {
  state.settings = replace ? mergeSettings(patch) : mergeSettings({ ...state.settings, ...patch });
  await db.put('settings', { key: 'settings', value: state.settings });
  changed('settings');
}
async function savePrefs() { await db.put('settings', { key: 'prefs', value: state.prefs }); }

// ---------- projects ----------
export function currentProject() { return state.projects.get(state.currentProjectId) || null; }
export function setCurrentProject(id) {
  state.currentProjectId = id; if (id) localStorage.setItem('clipforge.currentProject', id); else localStorage.removeItem('clipforge.currentProject');
  changed('project');
}
export function newProject(fields) {
  const now = Date.now();
  return { id: uid('prj'), name: 'Untitled project', createdAt: now, updatedAt: now, source: 'upload', status: 'new', duration: 0, size: 0, rights: false, mediaStored: false, ...fields };
}
export async function saveProject(p) {
  p.updatedAt = Date.now();
  state.projects.set(p.id, p);
  await db.put('projects', p);
  changed('project');
}
export async function deleteProject(id) {
  const p = state.projects.get(id);
  releaseUrl(id); state.sessionFiles.delete(id);
  const hls = highlightsOf(id);
  for (const hl of hls) { state.highlights.delete(hl.id); await db.deleteBy('feedback', 'highlightId', hl.id).catch(() => {}); }
  await Promise.all([db.delete('projects', id), db.delete('media', id), db.delete('timelines', id), db.deleteBy('highlights', 'projectId', id), db.deleteBy('exports', 'projectId', id)]);
  state.projects.delete(id);
  state.exportsLog = state.exportsLog.filter((e) => e.projectId !== id);
  if (state.currentProjectId === id) setCurrentProject([...state.projects.keys()][0] || null);
  changed('project'); refreshStorage();
  return p;
}

// ---------- media ----------
export async function attachMedia(project, file) {
  state.sessionFiles.set(project.id, file);
  releaseUrl(project.id);
  const limit = (state.settings.storeMediaMaxMB || 0) * 1048576;
  if (file.size <= limit) {
    try {
      await db.put('media', { projectId: project.id, blob: file, name: file.name, type: file.type, size: file.size });
      project.mediaStored = true;
    } catch (e) {
      project.mediaStored = false;
      toast(e.quota ? 'Browser storage is full — the video stays available for this session only.' : 'Could not persist the video: ' + e.message, 'warn', 8000);
    }
  } else project.mediaStored = false;
  await saveProject(project);
  refreshStorage();
}
export async function getMediaBlob(projectId) {
  if (state.sessionFiles.has(projectId)) return state.sessionFiles.get(projectId);
  const row = await db.get('media', projectId);
  if (row?.blob) { state.sessionFiles.set(projectId, row.blob); return row.blob; }
  return null;
}
export async function getMediaUrl(projectId) {
  if (urlCache.has(projectId)) return urlCache.get(projectId);
  const blob = await getMediaBlob(projectId); if (!blob) return null;
  const u = urls.create(blob); urlCache.set(projectId, u); return u;
}
export function releaseUrl(projectId) { const u = urlCache.get(projectId); if (u) { urls.revoke(u); urlCache.delete(projectId); } }

// ---------- timelines ----------
export const saveTimeline = (tl) => db.put('timelines', tl);
export const getTimeline = (pid) => db.get('timelines', pid);

// ---------- highlights ----------
export const highlightsOf = (pid) => [...state.highlights.values()].filter((h_) => h_.projectId === pid);
export async function saveHighlight(hl, silent = false) {
  state.highlights.set(hl.id, hl); await db.put('highlights', hl); if (!silent) changed('highlight');
}
export async function saveHighlights(list) {
  list.forEach((x) => state.highlights.set(x.id, x)); await db.putMany('highlights', list); changed('highlight');
}
export async function deleteHighlight(id) {
  state.highlights.delete(id); await db.delete('highlights', id); await db.deleteBy('feedback', 'highlightId', id).catch(() => {});
  if (state.currentHighlightId === id) state.currentHighlightId = null;
  changed('highlight'); refreshStorage();
}
export async function replaceProjectHighlights(pid, list) {
  // Keep user-curated clips (approved / manual) on re-detection.
  const old = highlightsOf(pid);
  const keep = old.filter((x) => x.manual || x.status === 'approved');
  for (const o of old) if (!keep.includes(o)) { state.highlights.delete(o.id); await db.delete('highlights', o.id); }
  const fresh = list.filter((n) => !keep.some((k) => n.start < k.end && n.end > k.start));
  await saveHighlights(fresh);
}

// ---------- feedback / preferences ----------
export async function addFeedback(hl, kind, opts = {}) {
  const entry = { id: uid('fb'), highlightId: hl.id, projectId: hl.projectId, kind, ts: Date.now(), category: hl.category, hookStrategy: opts.hookStrategy || hl.hooks?.find((x) => x.id === hl.selectedHook)?.strategy || null, score: hl.score };
  await db.put('feedback', entry);
  hl.feedback = [...(hl.feedback || []).filter((f) => f !== kind), kind];
  const cat = (state.prefs.category[hl.category] ||= { up: 0, down: 0, wrong: 0 });
  if (kind === 'great') cat.up++; else if (kind === 'boring') cat.down++; else if (kind === 'wrong') cat.wrong++;
  const strat = entry.hookStrategy;
  if (strat && (kind === 'goodhook' || kind === 'badhook')) { const r = state.prefs.hook[strat]; kind === 'goodhook' ? r.up++ : r.down++; }
  state.prefs.feedbackCount++;
  await Promise.all([savePrefs(), saveHighlight(hl)]);
  return entry;
}
export const allFeedback = () => db.getAll('feedback');

// ---------- history & exports ----------
export async function addHistory(type, status, message, project) {
  const e = { id: uid('h'), ts: Date.now(), type, status, message, projectId: project?.id || null, projectName: project?.name || '' };
  state.history.unshift(e); state.history = state.history.slice(0, 200);
  await db.put('history', e).catch(() => {}); changed('history'); return e;
}
export async function logExport(rec) {
  state.exportsLog.unshift(rec); await db.put('exports', rec); changed('exports');
}
export async function savePerf(entry) { const i = state.perf.findIndex((p) => p.id === entry.id); if (i >= 0) state.perf[i] = entry; else state.perf.push(entry); await db.put('perf', entry); changed('perf'); }
export async function deletePerf(id) { state.perf = state.perf.filter((p) => p.id !== id); await db.delete('perf', id); changed('perf'); }

// ---------- processing status (top bar) ----------
export function setProcessing(patch) { Object.assign(state.processing, patch); bus.emit('processing', state.processing); }
export function endProcessing(label = 'Idle', error = null) { setProcessing({ active: false, label, pct: error ? 0 : 100, cancel: null, error }); }

// ---------- backup / restore / wipe ----------
export async function exportAllMetadata() {
  const [feedback] = await Promise.all([db.getAll('feedback')]);
  const payload = {
    app: 'gta6-clipforge', version: 1, exportedAt: new Date().toISOString(),
    settings: state.settings, prefs: state.prefs, projects: [...state.projects.values()], highlights: [...state.highlights.values()],
    feedback, exports: state.exportsLog, perf: state.perf,
    note: 'Metadata only. Source videos and generated clips are not included; re-link recordings in the Video Library.',
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}
export async function importMetadata(file) {
  let data; try { data = JSON.parse(await file.text()); } catch { throw new Error('File is not valid JSON.'); }
  if (data.app !== 'gta6-clipforge' || !Array.isArray(data.projects)) throw new Error('This is not a ClipForge metadata export.');
  let np = 0, nh = 0;
  for (const p of data.projects) {
    if (state.projects.has(p.id)) continue;
    p.mediaStored = false; p.needsRelink = true; if (p.status === 'analyzing') p.status = 'interrupted';
    state.projects.set(p.id, p); await db.put('projects', p); np++;
  }
  for (const x of data.highlights || []) { if (!state.highlights.has(x.id) && state.projects.has(x.projectId)) { state.highlights.set(x.id, x); await db.put('highlights', x); nh++; } }
  for (const f of data.feedback || []) await db.put('feedback', f);
  for (const e of data.exports || []) { if (!state.exportsLog.some((z) => z.id === e.id)) { state.exportsLog.push(e); await db.put('exports', e); } }
  for (const e of data.perf || []) await savePerf(e);
  if (data.prefs) { state.prefs = { ...state.prefs, ...data.prefs }; await savePrefs(); }
  if (!state.currentProjectId) setCurrentProject([...state.projects.keys()][0] || null);
  changed('all'); refreshStorage();
  return { projects: np, highlights: nh };
}
export async function clearAllData() {
  for (const id of [...urlCache.keys()]) releaseUrl(id);
  state.sessionFiles.clear(); state.projects.clear(); state.highlights.clear(); state.exportsLog = []; state.history = []; state.perf = [];
  state.prefs = { category: {}, hook: { A: { up: 0, down: 0 }, B: { up: 0, down: 0 }, C: { up: 0, down: 0 } }, feedbackCount: 0 };
  await db.clearAll();
  await saveSettings({ ...state.settings, onboarded: true }, true);
  localStorage.removeItem('clipforge.currentProject'); state.currentProjectId = null;
  changed('all'); refreshStorage();
}
export { requestPersistence };
