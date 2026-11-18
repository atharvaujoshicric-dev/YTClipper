// AI Highlights review center.
import { h, icon, fmtTime, fmtDur, fmtDate, toast, confirmDialog, modal, emptyState, scoreBadge, scoreClass, scoreLabel, bus } from './utils.js';
import { state, currentProject, highlightsOf, saveHighlight, saveHighlights, deleteHighlight, addFeedback, getMediaUrl, setCurrentProject } from './state.js';
import { ALL_CATEGORIES, categoryLabel } from './event-classifier.js';
import { segmentsOf, outDuration, playSegments } from './hook-intelligence.js';
import { redetectProject, isAnalyzing } from './analyze.js';
import { SIGNAL_META } from './engagement-scorer.js';

const F = { score: new Set(), group: new Set(), dur: 'any', date: 'any', status: 'all', sort: 'score-desc' };
const GROUPS = { Funny: ['funny'], Action: ['action', 'police', 'explosion', 'crash', 'escape', 'driving', 'epic'], Reactions: ['reaction'], Unexpected: ['unexpected', 'npc'] };
const SCORE_RANGES = { Exceptional: [90, 101], Excellent: [80, 90], Good: [70, 80] };
export const exportSelection = new Set();

function applyFilters(list) {
  let out = list.filter((x) => {
    if (F.score.size && ![...F.score].some((k) => x.score >= SCORE_RANGES[k][0] && x.score < SCORE_RANGES[k][1])) return false;
    if (F.group.size && ![...F.group].some((g) => GROUPS[g].includes(x.category))) return false;
    const d = x.end - x.start; if (F.dur === 'short' && d >= 20) return false; if (F.dur === 'mid' && (d < 20 || d > 40)) return false; if (F.dur === 'long' && d <= 40) return false;
    if (F.date === 'today' && Date.now() - x.createdAt > 864e5) return false; if (F.date === 'week' && Date.now() - x.createdAt > 6048e5) return false;
    if (F.status !== 'all' && x.status !== F.status) return false;
    return true;
  });
  const s = { 'score-desc': (a, b) => b.score - a.score, 'score-asc': (a, b) => a.score - b.score, newest: (a, b) => b.createdAt - a.createdAt, longest: (a, b) => (b.end - b.start) - (a.end - a.start), shortest: (a, b) => (a.end - a.start) - (b.end - b.start) }[F.sort];
  return out.sort(s);
}

export function previewClip(hl) {
  getMediaUrl(hl.projectId).then((url) => {
    if (!url) return toast('Source video is not loaded. Re-link it in the Video Library.', 'warn');
    const v = h('video', { src: url, controls: false, playsinline: true, style: { width: '100%', maxHeight: '60vh', background: '#000', borderRadius: '10px' } });
    const tc = h('span', { class: 'mono small muted' }, ''); let stop = null;
    const segs = segmentsOf(hl); const total = outDuration(segs);
    const m = modal({ title: hl.title, wide: true, body: h('div', { class: 'stack' }, v, h('div', { class: 'row between' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { stop?.(); stop = playSegments(v, segs, 9999, (t) => (tc.textContent = `${t.toFixed(1)}s / ${total.toFixed(1)}s`)); } }, icon('play', 'sm'), 'Play with selected hook'), h('button', { class: 'btn', onclick: () => { stop?.(); stop = playSegments(v, [{ start: hl.start, end: hl.end }], 9999, (t) => (tc.textContent = `${t.toFixed(1)}s / ${(hl.end - hl.start).toFixed(1)}s`)); } }, 'Play original order')), tc),
      h('div', { class: 'small muted' }, `Source ${fmtTime(hl.start)} – ${fmtTime(hl.end)} · this is the raw footage; crop and captions are applied in the editor.`)), onClose: () => stop?.() });
    v.addEventListener('loadeddata', () => { stop = playSegments(v, segs, 9999, (t) => (tc.textContent = `${t.toFixed(1)}s / ${total.toFixed(1)}s`)); }, { once: true });
  });
}

export function mount(root) {
  const proj = currentProject();
  const head = h('div', { class: 'view-head fade-in' }, h('div', {}, h('h1', {}, icon('spark'), 'AI Highlights'), h('p', { class: 'sub' }, proj ? `Detected moments in “${proj.name}”. Scores are explainable heuristics of engagement potential — not predictions of views or virality.` : 'Detected moments appear here after you analyse a recording.')),
    proj ? h('div', { class: 'view-actions' }, h('button', { class: 'btn', disabled: isAnalyzing(), 'data-tip': 'Re-score with your current settings. Approved and manual clips are kept.', onclick: async () => { await redetectProject(proj); } }, 'Re-run detection')) : null);
  root.append(head);
  if (!proj) return root.append(emptyState('spark', 'No project selected', 'Import a recording or start a live capture to detect highlights.', [h('a', { class: 'btn primary', href: '#/library' }, 'Open Video Library')]));
  const filterBar = h('div', { class: 'card pad stack' }); const grid = h('div', { class: 'hl-grid' }); const bulk = h('div', { class: 'bulkbar hidden' });
  root.append(filterBar, h('div', { style: { height: '14px' } }), grid, bulk);
  const off = bus.on('change', (w) => { if (w !== 'settings') draw(); });
  const chip = (set, key, label) => h('button', { class: 'chip' + (set.has(key) ? ' on' : ''), onclick: () => { set.has(key) ? set.delete(key) : set.add(key); draw(); } }, label);
  const sel = (val, opts, fn, label) => h('select', { 'aria-label': label, style: { width: 'auto' }, onchange: (e) => fn(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));

  function draw() {
    const all = highlightsOf(proj.id); const list = applyFilters(all);
    filterBar.innerHTML = '';
    filterBar.append(h('div', { class: 'filters' }, h('span', { class: 'small dim' }, 'Score'), ...Object.keys(SCORE_RANGES).map((k) => chip(F.score, k, k)), h('span', { class: 'small dim', style: { marginLeft: '10px' } }, 'Type'), ...Object.keys(GROUPS).map((k) => chip(F.group, k, k))),
      h('div', { class: 'filters' }, sel(F.dur, [['any', 'Any duration'], ['short', '< 20 s'], ['mid', '20–40 s'], ['long', '> 40 s']], (v) => { F.dur = v; draw(); }, 'Duration'),
        sel(F.date, [['any', 'Any date'], ['today', 'Processed today'], ['week', 'Last 7 days']], (v) => { F.date = v; draw(); }, 'Date'),
        sel(F.status, [['all', 'All statuses'], ['candidate', 'Candidates'], ['approved', 'Approved'], ['rejected', 'Rejected']], (v) => { F.status = v; draw(); }, 'Status'),
        h('span', { class: 'spacer' }), h('span', { class: 'small dim' }, 'Sort'), sel(F.sort, [['score-desc', 'Highest score'], ['score-asc', 'Lowest score'], ['newest', 'Newest'], ['longest', 'Longest'], ['shortest', 'Shortest']], (v) => { F.sort = v; draw(); }, 'Sort'),
        h('span', { class: 'small muted' }, `${list.length} of ${all.length}`)));
    grid.innerHTML = '';
    if (!all.length) { grid.className = ''; grid.append(emptyState('spark', proj.status === 'analyzed' ? 'No highlights met your minimum score' : 'This project has not been analysed yet', proj.status === 'analyzed' ? `Nothing scored ≥ ${state.settings.minScore}. Lower “Minimum engagement score” or the sensitivity in Settings, then re-run detection.` : 'Analyse the recording to find exciting moments.', [proj.status === 'analyzed' ? h('a', { class: 'btn', href: '#/settings' }, 'Open Settings') : h('a', { class: 'btn primary', href: '#/library' }, 'Go to Library')])); bulk.classList.add('hidden'); return; }
    grid.className = 'hl-grid';
    if (!list.length) grid.append(emptyState('spark', 'No highlights match these filters', 'Clear a filter to see more.'));
    list.forEach((hl) => grid.append(card(hl)));
    updateBulk();
  }
  function updateBulk() {
    const ids = [...exportSelection].filter((id) => state.highlights.has(id));
    bulk.classList.toggle('hidden', !ids.length); bulk.innerHTML = '';
    bulk.append(h('b', {}, `${ids.length} selected`), h('button', { class: 'btn sm good', onclick: async () => { const items = ids.map((i) => state.highlights.get(i)); items.forEach((x) => (x.status = 'approved')); await saveHighlights(items); toast(`${items.length} approved.`, 'success'); } }, icon('check', 'sm'), 'Approve all'),
      h('button', { class: 'btn sm primary', onclick: async () => { const items = ids.map((i) => state.highlights.get(i)); items.forEach((x) => (x.status = 'approved')); await saveHighlights(items); location.hash = '#/export'; } }, icon('export', 'sm'), 'Bulk export…'),
      h('button', { class: 'btn sm danger', onclick: async () => { const items = ids.map((i) => state.highlights.get(i)); items.forEach((x) => (x.status = 'rejected')); await saveHighlights(items); exportSelection.clear(); draw(); } }, icon('x', 'sm'), 'Reject all'),
      h('button', { class: 'btn sm ghost', onclick: () => { exportSelection.clear(); draw(); } }, 'Clear selection'));
  }
  function card(hl) {
    const hook = hl.hooks?.find((x) => x.id === hl.selectedHook); const dur = hl.end - hl.start;
    const fb = (k, label, ic) => h('button', { class: 'btn sm ghost' + (hl.feedback?.includes(k) ? ' active' : ''), 'data-tip': label, onclick: async () => { await addFeedback(hl, k); toast('Thanks — saved to your local preferences.', 'success', 2000); } }, icon(ic, 'sm'));
    return h('div', { class: 'card hl-card fade-in ' + hl.status },
      h('div', { class: 'cover', style: { backgroundImage: hl.thumb ? `url(${hl.thumb})` : 'none' }, onclick: () => previewClip(hl) }, scoreBadge(hl.score), h('span', { class: 'dur' }, fmtDur(dur)), h('div', { class: 'play' }, icon('play'))),
      h('div', { class: 'body' },
        h('div', { class: 'row between' }, h('b', {}, hl.title), h('input', { type: 'checkbox', 'aria-label': 'Select', checked: exportSelection.has(hl.id), onchange: (e) => { e.target.checked ? exportSelection.add(hl.id) : exportSelection.delete(hl.id); updateBulk(); } })),
        h('div', { class: 'row' }, h('span', { class: 'tag ' + (hl.category === 'review' ? 'orange' : 'red') }, categoryLabel(hl.category)), h('span', { class: 'tag' }, scoreLabel(hl.score)), h('span', { class: 'tag ' + ({ High: 'green', Medium: 'blue', Low: '' }[hl.confidence]) }, hl.confidence + ' confidence · ' + hl.confidencePct + '%'),
          h('span', { class: 'tag', 'data-tip': hl.categoryMethod === 'heuristic' ? 'Category inferred from audio/visual heuristics' : hl.categoryMethod === 'keyword' ? 'Category supported by speech keywords' : hl.categoryMethod === 'manual' ? 'Set by you' : 'Not enough evidence for a category' }, hl.categoryMethod || 'uncertain')),
        h('div', { class: 'small muted' }, `Peak ${fmtTime(hl.peak)} · clip ${fmtTime(hl.start)}–${fmtTime(hl.end)}`),
        h('div', { class: 'why' }, hl.reasons.slice(0, 3).map((r) => h('div', {}, r))),
        h('div', { class: 'sig-bars' }, Object.entries(hl.signals).filter(([k]) => k !== 'prefs').flatMap(([k, v]) => [h('span', {}, SIGNAL_META[k].short), h('div', { class: 'meter' }, h('i', { style: { width: Math.round((v ?? 0) * 100) + '%', opacity: v == null ? 0.15 : 1 } })), h('span', {}, v == null ? 'n/a' : Math.round(v * 100))])),
        hook ? h('div', { class: 'small' }, h('span', { class: 'dim' }, 'Recommended hook: '), h('b', {}, `${hook.strategy} · ${hook.name}`), ` (${hook.quality})`) : null,
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Category'), h('select', { onchange: async (e) => { hl.category = e.target.value; hl.categoryMethod = 'manual'; hl.confidence = 'High'; hl.confidencePct = Math.max(hl.confidencePct, 85); await saveHighlight(hl); } }, ALL_CATEGORIES.map((c) => h('option', { value: c.id, selected: c.id === hl.category }, c.label)))),
        h('div', { class: 'hl-actions' },
          h('button', { class: 'btn sm', onclick: () => previewClip(hl) }, icon('play', 'sm'), 'Preview'),
          h('a', { class: 'btn sm', href: '#/editor', onclick: () => (state.currentHighlightId = hl.id) }, icon('scissors', 'sm'), 'Edit'),
          h('button', { class: 'btn sm good' + (hl.status === 'approved' ? ' active' : ''), onclick: async () => { hl.status = hl.status === 'approved' ? 'candidate' : 'approved'; await saveHighlight(hl); } }, icon('check', 'sm'), hl.status === 'approved' ? 'Approved' : 'Approve'),
          h('button', { class: 'btn sm danger' + (hl.status === 'rejected' ? ' active' : ''), onclick: async () => { hl.status = hl.status === 'rejected' ? 'candidate' : 'rejected'; await saveHighlight(hl); } }, icon('x', 'sm'), hl.status === 'rejected' ? 'Rejected' : 'Reject'),
          h('button', { class: 'btn sm ghost icon', 'aria-label': 'Delete', 'data-tip': 'Delete', onclick: async () => { if (await confirmDialog('Delete this highlight?', 'The clip and its edits are removed. The source recording is untouched.', { okText: 'Delete', danger: true })) { exportSelection.delete(hl.id); await deleteHighlight(hl.id); } } }, icon('trash', 'sm'))),
        h('div', { class: 'row', style: { gap: '4px' } }, fb('great', 'Great clip', 'thumb-up'), fb('boring', 'Not interesting', 'thumb-down'), fb('wrong', 'Wrong detection', 'warn'), fb('goodhook', 'Good hook', 'hook'), h('span', { class: 'small dim' }, 'Your feedback tunes ranking locally'))));
  }
  draw();
  return () => off();
}
