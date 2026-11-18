// Local analytics. Estimated engagement potential is kept strictly separate from actual performance numbers you enter yourself.
import { h, icon, fmtDur, toast, uid, emptyState, bus, confirmDialog } from './utils.js';
import { state, allFeedback, savePerf, deletePerf } from './state.js';
import { categoryLabel } from './event-classifier.js';

function bars(rows, max) {
  const m = max || Math.max(1, ...rows.map((r) => r[1]));
  return h('div', { class: 'bars' }, rows.map(([l, v, extra]) => h('div', { class: 'bar-row' }, h('span', { title: l }, l), h('div', { class: 'meter' }, h('i', { style: { width: (v / m) * 100 + '%' } })), h('b', {}, extra ?? v))));
}
function spearman(xs, ys) {
  const rank = (a) => { const s = [...a].map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = Array(a.length); s.forEach(([, i], k) => (r[i] = k + 1)); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length; const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

export async function mount(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('div', { class: 'view-head fade-in' }, h('div', {}, h('h1', {}, icon('chart'), 'Analytics'), h('p', { class: 'sub' }, 'Local statistics about your clips and feedback. Estimated engagement potential is a heuristic and is never mixed with real social-media performance, which only appears if you type it in below.'))), body);
  const off = bus.on('change', () => draw());
  let fb = await allFeedback(); draw();
  function draw() {
    body.innerHTML = '';
    const projects = [...state.projects.values()], hls = [...state.highlights.values()];
    if (!projects.length) return body.append(emptyState('chart', 'No data yet', 'Analytics fill in as you analyse recordings, review clips and export.', [h('a', { class: 'btn primary', href: '#/library' }, 'Import a recording')]));
    const approved = hls.filter((x) => x.status === 'approved').length, rejected = hls.filter((x) => x.status === 'rejected').length;
    const avg = hls.length ? hls.reduce((a, x) => a + x.score, 0) / hls.length : 0; const avgDur = hls.length ? hls.reduce((a, x) => a + (x.end - x.start), 0) / hls.length : 0;
    const catCount = {}; hls.forEach((x) => (catCount[x.category] = (catCount[x.category] || 0) + 1)); const topCat = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0];
    const hookRows = Object.entries(state.prefs.hook).map(([k, v]) => [`Strategy ${k} (${{ A: 'Action', B: 'Reaction', C: 'Context' }[k]})`, v.up - v.down, `${v.up}👍 ${v.down}👎`]);
    const hookRated = Object.values(state.prefs.hook).some((v) => v.up || v.down); const bestHook = hookRated ? Object.entries(state.prefs.hook).sort((a, b) => b[1].up - b[1].down - (a[1].up - a[1].down))[0] : null;
    const stat = (k, v, s) => h('div', { class: 'card stat-card' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 's' }, s || ''));
    const bins = [0, 0, 0, 0, 0]; hls.forEach((x) => bins[x.score >= 90 ? 4 : x.score >= 80 ? 3 : x.score >= 70 ? 2 : x.score >= 50 ? 1 : 0]++); const bm = Math.max(1, ...bins);
    body.append(
      h('div', { class: 'grid cols-5' }, stat('Videos analysed', projects.filter((p) => p.status === 'analyzed').length), stat('Candidate clips', hls.length), stat('Approved', approved), stat('Rejected', rejected), stat('Exported', state.exportsLog.filter((e) => e.status === 'done').length)),
      h('div', { class: 'grid cols-3' }, stat('Average engagement score', avg ? avg.toFixed(1) : '—', 'heuristic potential'), stat('Most common category', topCat ? categoryLabel(topCat[0]) : '—', topCat ? topCat[1] + ' clip(s)' : ''), stat('Average clip duration', avgDur ? fmtDur(avgDur) : '—')),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Event categories')), Object.keys(catCount).length ? bars(Object.entries(catCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => [categoryLabel(k), v])) : h('div', { class: 'help' }, 'No clips.')),
        h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Score distribution')), h('div', { class: 'hist', style: { marginBottom: '22px' } }, ...bins.map((b, i) => h('div', { style: { height: (b / bm) * 100 + '%' }, title: b + ' clips' }, h('span', {}, ['<50', '50–69', '70–79', '80–89', '90+'][i] + ' (' + b + ')')))))),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Hook strategy ratings (your feedback)')), bars(hookRows.map(([l, v, e]) => [l, Math.max(0, v), e]), Math.max(1, ...hookRows.map((r) => Math.abs(r[1])))),
          h('div', { class: 'small muted', style: { marginTop: '10px' } }, bestHook ? `Best-rated so far: Strategy ${bestHook[0]} (net ${bestHook[1].up - bestHook[1].down}). Based only on ${state.prefs.feedbackCount} local feedback click(s).` : 'No hook ratings yet — use 👍 / 👎 in Hook Intelligence.')),
        h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Your feedback')), fb.length ? bars(Object.entries(fb.reduce((a, f) => ((a[f.kind] = (a[f.kind] || 0) + 1), a), {})).map(([k, v]) => [{ great: 'Great clip', boring: 'Not interesting', wrong: 'Wrong detection', goodhook: 'Good hook', badhook: 'Bad hook' }[k] || k, v])) : h('div', { class: 'help' }, 'No feedback yet. Feedback adjusts ranking through a simple local rules-based preference score — it does not train a model.'))),
      perfCard());
  }
  function perfCard() {
    const exported = [...state.highlights.values()].filter((x) => x.exportedCount > 0 || x.status === 'approved');
    const f = { hl: h('select', {}, exported.map((x) => h('option', { value: x.id }, `${x.score} · ${x.title}`))), platform: h('select', {}, ['Instagram Reels', 'YouTube Shorts'].map((p) => h('option', {}, p))), views: h('input', { type: 'number', min: 0, placeholder: 'views' }), likes: h('input', { type: 'number', min: 0, placeholder: 'likes' }), watch: h('input', { type: 'number', min: 0, max: 100, placeholder: 'avg % watched' }), note: h('input', { type: 'text', placeholder: 'notes / link (optional)' }) };
    const rows = state.perf.map((p) => ({ ...p, hl: state.highlights.get(p.highlightId) }));
    const card = h('div', { class: 'card pad stack' }, h('div', { class: 'card-head' }, h('h3', {}, 'Actual performance (entered by you)')),
      h('div', { class: 'notice' }, icon('help'), 'ClipForge cannot see your Instagram or YouTube statistics. Enter real numbers manually to compare them with the estimated scores. Nothing here is fabricated or fetched.'),
      exported.length ? h('div', { class: 'grid cols-3' }, ...Object.values(f).map((el, i) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, ['Clip', 'Platform', 'Views', 'Likes', 'Avg % watched', 'Notes'][i]), el))) : h('div', { class: 'help' }, 'Approve or export a clip first, then record how it performed.'),
      exported.length ? h('div', {}, h('button', { class: 'btn primary', onclick: async () => { if (f.views.value === '') return toast('Enter at least the view count.', 'warn'); await savePerf({ id: uid('perf'), highlightId: f.hl.value, platform: f.platform.value, views: +f.views.value, likes: f.likes.value === '' ? null : +f.likes.value, watchPct: f.watch.value === '' ? null : +f.watch.value, note: f.note.value, ts: Date.now() }); toast('Saved.', 'success'); } }, 'Save result')) : null);
    if (rows.length) {
      card.append(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Clip', 'Platform', 'Estimated score', 'Actual views', 'Likes', '% watched', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.hl?.title || '(deleted clip)'), h('td', {}, r.platform), h('td', {}, r.hl ? r.hl.score : '—'), h('td', {}, r.views.toLocaleString()), h('td', {}, r.likes ?? '—'), h('td', {}, r.watchPct != null ? r.watchPct + '%' : '—'), h('td', {}, h('button', { class: 'btn sm ghost icon', 'aria-label': 'Delete', onclick: () => deletePerf(r.id) }, icon('trash', 'sm'))))))));
      const pairs = rows.filter((r) => r.hl); if (pairs.length >= 3) { const rho = spearman(pairs.map((r) => r.hl.score), pairs.map((r) => r.views)); card.append(h('div', { class: 'notice' }, icon('chart'), rho == null ? 'Not enough variation to compare.' : `Rank correlation between estimated score and actual views: ρ = ${rho.toFixed(2)} (n = ${pairs.length}). With so few clips this is anecdotal, and views depend on far more than the footage (audience, timing, platform).`)); }
      else card.append(h('div', { class: 'help' }, 'Add at least 3 results to see how estimated scores compare with real performance.'));
    }
    return card;
  }
  return () => off();
}
