// Hook Intelligence: three opening strategies per clip, each scored from the first ~3 s of the resulting video.
import { h, icon, fmtTime, toast, clamp, emptyState, scoreBadge, uid, once, seekTo } from './utils.js';
import { state, saveHighlight, addFeedback, getMediaUrl, getTimeline, currentProject, highlightsOf } from './state.js';
import { computeSignals, STEP } from './engagement-scorer.js';
import { categoryLabel } from './event-classifier.js';

// ---------- segment helpers (shared with editor / exporter) ----------
export const segmentsOf = (hl) => { const k = hl.hooks?.find((x) => x.id === hl.selectedHook); return k?.segments?.length ? k.segments : [{ start: hl.start, end: hl.end }]; };
export const outDuration = (segs) => segs.reduce((a, s) => a + (s.end - s.start), 0);
export function outToSrc(segs, t) {
  let acc = 0;
  for (let i = 0; i < segs.length; i++) { const d = segs[i].end - segs[i].start; if (t < acc + d || i === segs.length - 1) return { src: segs[i].start + clamp(t - acc, 0, d), seg: i, segOut: acc }; acc += d; }
  return { src: segs[0].start, seg: 0, segOut: 0 };
}
export function srcToOut(segs, src) {
  let acc = 0;
  for (const s of segs) { if (src >= s.start && src <= s.end) return acc + (src - s.start); acc += s.end - s.start; }
  return 0;
}

const OVERLAY_TEMPLATES = {
  default: ['WAIT FOR WHAT HAPPENS NEXT', 'I DID NOT EXPECT THAT', 'THE CRAZIEST GTA MOMENT'],
  unexpected: ['THIS WAS NOT SUPPOSED TO HAPPEN', 'I DID NOT EXPECT THAT', 'WAIT FOR WHAT HAPPENS NEXT'],
  fail: ['BRO GOT THE WORST LUCK', 'THIS WAS NOT SUPPOSED TO HAPPEN', 'WAIT FOR WHAT HAPPENS NEXT'],
  funny: ['BRO GOT THE WORST LUCK', 'I DID NOT EXPECT THAT', 'THE CRAZIEST GTA MOMENT'],
  police: ['THE CRAZIEST GTA MOMENT', 'WAIT FOR WHAT HAPPENS NEXT', 'FIVE STARS AND NO PLAN'],
  explosion: ['THE CRAZIEST GTA MOMENT', 'WAIT FOR WHAT HAPPENS NEXT', 'THIS WAS NOT SUPPOSED TO HAPPEN'],
  crash: ['THIS WAS NOT SUPPOSED TO HAPPEN', 'BRO GOT THE WORST LUCK', 'WAIT FOR WHAT HAPPENS NEXT'],
};
export function overlaySuggestions(hl, tl) {
  const out = [];
  const kw = (tl?.speech?.segments || []).filter((s) => s.t >= hl.start - 1 && s.t <= hl.end).flatMap((s) => s.hits || []);
  if (kw[0]) out.push({ text: kw[0].phrase.toUpperCase() + '!', source: 'speech', note: 'From a phrase actually heard in this clip.' });
  (OVERLAY_TEMPLATES[hl.category] || OVERLAY_TEMPLATES.default).forEach((t) => out.push({ text: t, source: 'template', note: 'Creative suggestion — not derived from the footage.' }));
  return out;
}

function peakIn(sig, a, b, f) {
  let best = -1, bi = Math.round(a / STEP);
  for (let i = Math.max(0, Math.round(a / STEP)); i <= Math.min(sig.n - 1, Math.round(b / STEP)); i++) { const v = f(i); if (v > best) { best = v; bi = i; } }
  return { t: bi * STEP, v: best };
}
function hookQuality(segs, sig, strat, prefs, flags) {
  // Look at the first 3 s of OUTPUT.
  const first = []; let acc = 0;
  for (const s of segs) { for (let t = s.start; t < s.end && acc < 3; t += STEP, acc += STEP) first.push(Math.round(t / STEP)); if (acc >= 3) break; }
  const at = (arr, i) => (i >= 0 && i < arr.length ? arr[i] : 0);
  const act = (i) => 0.55 * at(sig.visual, i) + 0.45 * at(sig.audio, i);
  const s1 = Math.max(0, ...first.map(act));
  const imm = Math.max(0, ...first.slice(0, 2).map(act));
  const rx = Math.max(0, ...first.map((i) => at(sig.speech, i)));
  const rear = flags.rearranged ? 6 : 0, weak = flags.weak ? 10 : 0;
  const strat_ = prefs?.hook?.[strat] || { up: 0, down: 0 };
  const prior = clamp((strat_.up - strat_.down) * 2, -6, 6);
  const q = clamp(100 * (0.45 * s1 + 0.3 * imm + 0.25 * rx) + 8 - rear - weak + prior, 0, 100);
  return { quality: Math.round(q), breakdown: { 'First 3 s action': Math.round(s1 * 100), 'Immediate stimulus (first 1 s)': Math.round(imm * 100), 'Reaction in first 3 s': Math.round(rx * 100), 'Rearrangement penalty': -rear, 'Weak-evidence penalty': -weak, 'Your hook feedback': Math.round(prior) } };
}

export function generateHooks(hl, tl, settings, prefs) {
  const sig = computeSignals(tl, settings);
  const { start, end } = hl; const A = (i) => 0.6 * (sig.visual[i] || 0) + 0.4 * (sig.audio[i] || 0);
  const peak = peakIn(sig, hl.eventStart ?? start, hl.eventEnd ?? end, A).t;
  const rx = peakIn(sig, Math.max(start, peak - 1), end, (i) => sig.speech[i] || 0);
  const hasReaction = sig.avail.speech && rx.v >= 0.4;
  const hooks = [];
  const mk = (strategy, name, segments, why, flags = {}) => {
    segments = segments.map((s) => ({ ...s, start: +clamp(s.start, 0, tl.duration).toFixed(2), end: +clamp(s.end, 0, tl.duration).toFixed(2) })).filter((s) => s.end - s.start > 0.3);
    let total = outDuration(segments); const max = settings.clipMax + 6;
    if (total > max) { const last = segments[segments.length - 1]; last.end = +(last.end - (total - max)).toFixed(2); total = outDuration(segments); }
    const q = hookQuality(segments, sig, strategy, prefs, flags);
    hooks.push({ id: uid('hk'), strategy, name, segments, openTs: segments[0].start, duration: +total.toFixed(1), ...q, why, rearranged: !!flags.rearranged, weak: !!flags.weak, narrativeNote: flags.note || null });
  };

  // A — Action first
  if (peak - start <= 4) mk('A', 'Action first', [{ start: Math.max(start, peak - 1.0), end }], `Opens ~1 s before the strongest action/audio peak at ${fmtTime(peak)}; the original order is preserved.`);
  else mk('A', 'Action first', [{ start: peak - 1.2, end: peak + 1.8, teaser: true }, { start, end }], `Shows a 3 s teaser of the peak (${fmtTime(peak)}) first, then plays the complete clip in its original order so the story stays understandable.`, { rearranged: true, note: 'Rearranged: a repeated teaser precedes the clip. The full sequence follows unchanged.' });

  // B — Reaction first
  if (hasReaction) {
    if (rx.t > peak + 1.5) mk('B', 'Reaction first', [{ start: rx.t - 0.6, end: rx.t + 2.2, teaser: true }, { start, end }], `Opens on the strongest reaction (${fmtTime(rx.t)}, ${sig.speechMethod.includes('speech-api') ? 'speech/keyword evidence' : 'voice-band burst'}), then shows the gameplay that caused it.`, { rearranged: true, note: 'Rearranged: the reaction is shown first, then the original clip. Nothing is removed.' });
    else mk('B', 'Reaction first', [{ start: Math.max(start, rx.t - 1.0), end }], `The reaction (${fmtTime(rx.t)}) already happens early, so the clip simply opens just before it.`);
  } else {
    const lp = peakIn(sig, start, end, (i) => (tl.audio?.available ? (Math.max(0, (tl.audio.rmsDb[i] || -90) + 90) / 90) : sig.audio[i]));
    mk('B', 'Reaction first', [{ start: Math.max(start, lp.t - 1.0), end }], 'No clear reaction was detected; opens at the loudest moment instead. Treat as low-evidence.', { weak: true });
  }

  // C — Context first
  const ctxStart = Math.max(start, peak - 4.5);
  mk('C', 'Context first', [{ start: peak - start < 2 ? start : ctxStart, end }], `Gives ~${Math.round(peak - ctxStart)} s of setup before the payoff at ${fmtTime(peak)}, in original order (no rearrangement).`);

  const pick = settings.hookStrategy !== 'auto' ? hooks.find((x) => x.strategy === settings.hookStrategy) : null;
  const best = pick || [...hooks].sort((a, b) => b.quality - a.quality)[0];
  return { hooks, selectedHook: best.id, peakTime: peak };
}

/** Plays hook segments in a <video> for `maxSec` output seconds; returns stop(). */
export function playSegments(video, segs, maxSec = 3.5, onTick) {
  let i = 0, acc = 0, stopped = false, raf;
  const begin = async () => { await seekTo(video, segs[0].start); video.muted = false; try { await video.play(); } catch { video.muted = true; await video.play().catch(() => {}); } loop(); };
  const loop = async () => {
    if (stopped) return;
    const s = segs[i]; const out = acc + (video.currentTime - s.start);
    onTick?.(out);
    if (out >= maxSec) return stop();
    if (video.currentTime >= s.end - 0.03) {
      acc += s.end - s.start; i++;
      if (i >= segs.length) return stop();
      video.pause(); await seekTo(video, segs[i].start); if (stopped) return; await video.play().catch(() => {});
    }
    raf = requestAnimationFrame(loop);
  };
  const stop = () => { stopped = true; cancelAnimationFrame(raf); video.pause(); };
  begin();
  return stop;
}

// ---------- view ----------
export function mount(root) {
  const proj = currentProject();
  const list = proj ? highlightsOf(proj.id).filter((x) => x.status !== 'rejected').sort((a, b) => b.score - a.score) : [];
  root.append(h('div', { class: 'view-head fade-in' }, h('div', {}, h('h1', {}, icon('hook'), 'Hook Intelligence'), h('p', { class: 'sub' }, 'The first 1–3 seconds decide whether people keep watching. Each clip gets three opening strategies — preview them, compare their hook scores, and pick one. Scores are heuristics from the first 3 s of audio/visual activity, not predictions of retention.'))));
  if (!list.length) { root.append(emptyState('hook', 'No highlights to optimise yet', 'Analyse a recording first. Hook strategies are generated for every detected highlight.', [h('a', { class: 'btn primary', href: '#/library' }, 'Open Video Library')])); return; }
  let cur = list.find((x) => x.id === state.currentHighlightId) || list[0];
  const stops = []; const holder = h('div', { class: 'stack' });
  const picker = h('select', { 'aria-label': 'Choose highlight', onchange: (e) => { cur = list.find((x) => x.id === e.target.value); state.currentHighlightId = cur.id; draw(); } },
    list.map((x) => h('option', { value: x.id, selected: x.id === cur.id }, `${Math.round(x.score)} · ${x.title} · ${fmtTime(x.start)}–${fmtTime(x.end)}`)));
  root.append(h('div', { class: 'card pad fade-in', style: { marginBottom: '16px' } }, h('div', { class: 'row' }, h('label', { class: 'field', style: { flex: 1, minWidth: '260px' } }, h('span', { class: 'lbl' }, 'Highlight'), picker),
    h('button', { class: 'btn', onclick: async () => { const tl = await getTimeline(proj.id); if (!tl) return toast('No analysis data stored for this project — re-run analysis.', 'warn'); Object.assign(cur, generateHooks(cur, tl, state.settings, state.prefs)); await saveHighlight(cur); toast('Hooks regenerated.', 'success'); draw(); } }, 'Regenerate hooks'),
    h('a', { class: 'btn primary', href: '#/editor', onclick: () => { state.currentHighlightId = cur.id; } }, icon('scissors', 'sm'), 'Edit this clip'))), holder);

  async function draw() {
    stops.forEach((s) => s()); stops.length = 0; holder.innerHTML = '';
    const url = await getMediaUrl(proj.id);
    const tl = await getTimeline(proj.id);
    if (!cur.hooks?.length) {
      if (tl) { Object.assign(cur, generateHooks(cur, tl, state.settings, state.prefs)); await saveHighlight(cur, true); }
      else { holder.append(emptyState('hook', 'No hook data', 'Analysis data for this project is missing; re-run analysis from the Video Library.')); return; }
    }
    const sugg = overlaySuggestions(cur, tl);
    const grid = h('div', { class: 'hook-grid' });
    for (const hk of cur.hooks) {
      const selected = cur.selectedHook === hk.id;
      const v = h('video', { muted: true, playsinline: true, preload: 'auto', src: url || '', style: { background: '#000' } });
      const tc = h('span', { class: 'mono small muted' }, '0.0s / 3.5s');
      const play = h('button', { class: 'btn sm', disabled: !url, onclick: () => { stops.forEach((s) => s()); stops.length = 0; if (!url) return; stops.push(playSegments(v, hk.segments, 3.5, (t) => (tc.textContent = t.toFixed(1) + 's / 3.5s'))); } }, icon('play', 'sm'), 'Preview first 3.5 s');
      grid.append(h('div', { class: 'card hook-card' + (selected ? ' selected' : '') },
        h('div', { class: 'row between' }, h('div', {}, h('h3', {}, `Strategy ${hk.strategy}`), h('div', { class: 'muted small' }, hk.name)),
          h('div', { class: 'ring', style: { '--p': hk.quality }, 'data-tip': 'Hook quality score (heuristic)' }, h('span', {}, hk.quality))),
        url ? v : h('div', { class: 'empty' }, 'Source video not loaded — re-link it in the Video Library to preview.'),
        h('div', { class: 'row between' }, play, tc),
        h('div', { class: 'small muted' }, hk.why),
        hk.narrativeNote ? h('div', { class: 'notice warn small' }, icon('warn', 'sm'), hk.narrativeNote) : null,
        hk.weak ? h('div', { class: 'notice warn small' }, icon('warn', 'sm'), 'Low-evidence hook: no reaction detected.') : null,
        h('div', { class: 'row small' }, h('span', { class: 'dim' }, 'Opens at'), h('b', { class: 'mono' }, fmtTime(hk.openTs, true)), h('span', { class: 'dim' }, '· length'), h('b', {}, hk.duration + 's')),
        h('div', { class: 'seg-list' }, hk.segments.map((s) => h('span', { class: 'tag' + (s.teaser ? ' orange' : '') }, `${fmtTime(s.start)}–${fmtTime(s.end)}${s.teaser ? ' teaser' : ''}`))),
        h('details', {}, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Why this score?'), h('div', { class: 'small', style: { marginTop: '6px' } }, Object.entries(hk.breakdown).map(([k, val]) => h('div', { class: 'row between' }, h('span', { class: 'muted' }, k), h('b', {}, val))))),
        h('div', { class: 'row' },
          h('button', { class: 'btn ' + (selected ? 'primary' : ''), onclick: async () => { cur.selectedHook = hk.id; await saveHighlight(cur); toast(`Strategy ${hk.strategy} selected.`, 'success'); draw(); } }, icon('check', 'sm'), selected ? 'Selected' : 'Use this hook'),
          h('button', { class: 'btn sm icon', 'data-tip': 'Good hook', onclick: async () => { await addFeedback(cur, 'goodhook', { hookStrategy: hk.strategy }); toast('Saved: good hook (local preference).', 'success'); } }, icon('thumb-up', 'sm')),
          h('button', { class: 'btn sm icon', 'data-tip': 'Bad hook', onclick: async () => { await addFeedback(cur, 'badhook', { hookStrategy: hk.strategy }); toast('Saved: bad hook (local preference).', 'success'); } }, icon('thumb-down', 'sm')))));
    }
    holder.append(grid);
    const txt = h('input', { type: 'text', placeholder: 'Hook text overlay (shown for the first 3 s)', value: cur.overlays.find((o) => o.isHook)?.text || '' });
    const apply = async (text, source) => {
      cur.overlays = cur.overlays.filter((o) => !o.isHook);
      if (text) cur.overlays.push({ id: uid('ov'), isHook: true, text, x: 0.5, y: 0.2, size: 84, color: '#ffffff', outline: true, shadow: true, box: false, outStart: 0, outEnd: 3, creative: source !== 'speech' });
      await saveHighlight(cur); toast(text ? 'Hook text added to the clip.' : 'Hook text removed.', 'success');
    };
    holder.append(h('div', { class: 'card pad' }, h('div', { class: 'card-head' }, h('h3', {}, 'Hook text overlay')),
      h('div', { class: 'row' }, txt, h('button', { class: 'btn primary', onclick: () => apply(txt.value.trim(), 'custom') }, 'Apply'), h('button', { class: 'btn', onclick: () => { txt.value = ''; apply('', ''); } }, 'Remove')),
      h('div', { class: 'row', style: { marginTop: '10px' } }, sugg.map((s) => h('button', { class: 'chip', 'data-tip': s.note, onclick: () => { txt.value = s.text; apply(s.text, s.source); } }, (s.source === 'speech' ? '🎙 ' : '✦ ') + s.text))),
      h('div', { class: 'help', style: { marginTop: '8px' } }, '🎙 = taken from speech in this clip · ✦ = creative template suggestion, not derived from the footage.')));
  }
  draw();
  return () => { stops.forEach((s) => s()); };
}
