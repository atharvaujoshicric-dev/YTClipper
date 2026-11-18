// Evidence-based event classification. Only labels what the available signals can support;
// otherwise returns "Potential Highlight — Needs Review". No object/scene recognition model is bundled.
import { clamp } from './utils.js';
import { STEP } from './engagement-scorer.js';

export const CATEGORIES = [
  { id: 'epic', label: 'Epic Moments' }, { id: 'funny', label: 'Funny Moments' }, { id: 'unexpected', label: 'Unexpected Moments' },
  { id: 'police', label: 'Police Chases' }, { id: 'explosion', label: 'Explosions' }, { id: 'crash', label: 'Car Crashes' },
  { id: 'driving', label: 'Amazing Driving' }, { id: 'action', label: 'Action Sequences' }, { id: 'reaction', label: 'Streamer Reactions' },
  { id: 'close', label: 'Close Calls' }, { id: 'discovery', label: 'Interesting Discoveries' }, { id: 'story', label: 'Story Moments' },
  { id: 'npc', label: 'Unexpected NPC Behaviour' }, { id: 'fail', label: 'Failures and Mistakes' }, { id: 'escape', label: 'Insane Escapes' },
];
export const REVIEW = { id: 'review', label: 'Potential Highlight — Needs Review' };
export const categoryLabel = (id) => (CATEGORIES.find((c) => c.id === id) || REVIEW).label;
export const ALL_CATEGORIES = [...CATEGORIES, REVIEW];

// Words in the speech transcript that support a semantic category. (Transcripts exist only for live capture.)
const KEYWORDS = {
  funny: ['haha', 'lol', 'lmao', 'funny', 'hilarious', 'laughing', 'im dead', 'bruh'],
  police: ['cops', 'police', 'wanted', 'chase', 'chasing', 'five stars', 'swat'],
  crash: ['crash', 'crashed', 'wrecked', 'smashed', 'collision', 'totaled'],
  driving: ['drift', 'drifting', 'ramp', 'jump', 'insane driving', 'smooth', 'perfect landing'],
  close: ['close one', 'almost', 'barely', 'nearly', 'phew', 'that was close'],
  discovery: ['found', 'secret', 'hidden', 'easter egg', 'what is that', 'look at this', 'never seen'],
  story: ['mission', 'cutscene', 'cinematic', 'story', 'character'],
  npc: ['npc', 'pedestrian', 'random guy', 'why is he', 'what is he doing', 'why is she'],
  fail: ['oops', 'fail', 'failed', 'ugh', 'damn', 'wasted', 'busted', 'i died', 'my bad', 'stupid'],
  escape: ['escape', 'escaped', 'got away', 'lost them', 'lost the cops', 'lose them'],
  explosion: ['explosion', 'exploded', 'blew up', 'boom', 'bomb'],
};
const REACTION_WORDS = ['oh my god', 'no way', 'what just happened', 'lets go', 'holy shit', 'are you serious', 'i cant believe it', 'bro', 'wait'];
const norm = (s) => String(s).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function at(arr, i) { return arr && i >= 0 && i < arr.length ? arr[i] : 0; }

export function gatherEvidence(tl, sig, i0, i1, peak) {
  const A = tl.audio?.available ? tl.audio : null, V = tl.visual?.available ? tl.visual : null;
  let lastDom = 0;
  const ev = { flips: 0, riseDb: 0, crest: 0, low: 0, voice: 0, peakDb: -120, motionBins: 0, actionBins: 0, motionMax: 0, warmDelta: 0, brightDelta: 0, rbBins: 0, sceneMax: 0, kw: [], transcript: '' };
  for (let i = i0; i <= i1; i++) {
    if (A) { ev.riseDb = Math.max(ev.riseDb, at(sig.raw.rise, i)); ev.crest = Math.max(ev.crest, at(A.crest, i)); ev.low = Math.max(ev.low, at(A.low, i)); ev.voice = Math.max(ev.voice, at(A.voice, i)); ev.peakDb = Math.max(ev.peakDb, at(A.peakDb, i)); }
    if (V) {
      ev.motionMax = Math.max(ev.motionMax, at(V.motion, i)); ev.warmDelta = Math.max(ev.warmDelta, at(V.warmDelta, i)); ev.brightDelta = Math.max(ev.brightDelta, at(V.brightDelta, i));
      ev.sceneMax = Math.max(ev.sceneMax, at(V.scene, i));
      const r_ = at(V.red, i), b_ = at(V.blue, i); if (Math.max(r_, b_) > 0.004) { const d = r_ > b_ ? 1 : -1; if (lastDom && d !== lastDom) ev.flips++; lastDom = d; ev.rbBins++; }
    }
    if (sig.visual[i] > 0.5) ev.motionBins++;
    if (sig.visual[i] > 0.45 && sig.audio[i] > 0.35) ev.actionBins++;
  }
  const t0 = i0 * STEP - 2, t1 = i1 * STEP + 6;
  for (const s of tl.speech?.segments || []) if (s.t >= t0 && s.t <= t1) { ev.transcript += ' ' + norm(s.text); for (const h of s.hits || []) ev.kw.push(h.phrase); }
  ev.transcript = ' ' + ev.transcript.trim() + ' ';
  return ev;
}
const hasWord = (ev, list) => list.filter((w) => ev.transcript.includes(' ' + norm(w) + ' '));

export function classify(tl, sig, region, signals, score, settings) {
  const { i0, i1, peak } = region;
  const ev = gatherEvidence(tl, sig, i0, i1, peak);
  const cands = []; // {id, conf, method, why}
  const add = (id, conf, method, why) => cands.push({ id, conf: clamp(conf, 0, 0.95), method, why });
  const strong = Object.entries(signals).filter(([k, v]) => k !== 'prefs' && v != null && v >= 0.6).map(([k]) => k);

  // keyword-supported semantic categories
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    const found = hasWord(ev, words);
    if (found.length) add(cat, 0.78 + Math.min(0.12, found.length * 0.04), 'keyword', `Speech contained ${found.map((f) => '“' + f + '”').join(', ')}`);
  }
  // custom user keywords add weight to reaction (can't know the category)
  const reactionHits = hasWord(ev, REACTION_WORDS);
  if (reactionHits.length) add('reaction', 0.8, 'keyword', `Reaction phrase heard: ${reactionHits.map((f) => '“' + f + '”').join(', ')}`);
  else if (ev.voice > 0.55 && ev.riseDb > 6 && signals.speech != null && signals.speech >= 0.45) add('reaction', 0.55, 'heuristic', `Sudden voice-band loudness burst (+${ev.riseDb.toFixed(0)} dB) near the peak — consistent with a vocal reaction (not speech recognition)`);

  // heuristic audio/visual categories
  if (ev.crest >= 14 && ev.riseDb >= 8 && ev.low >= 0.3 && (ev.warmDelta >= 0.03 || ev.brightDelta >= 0.06)) add('explosion', 0.62 + Math.min(0.15, ev.warmDelta * 2), 'heuristic', `Impulsive low-frequency audio burst (+${ev.riseDb.toFixed(0)} dB, crest ${ev.crest.toFixed(0)} dB) coinciding with a warm/bright flash`);
  if (ev.flips >= 3 && ev.motionBins >= 3) add('police', 0.5 + Math.min(0.15, ev.flips * 0.03), 'heuristic', `Saturated red and blue alternated ${ev.flips} times while motion stayed high — possible police-light flicker (colour heuristic only, can be wrong)`);
  if (ev.actionBins >= 6) add('action', 0.55 + Math.min(0.2, ev.actionBins * 0.015), 'heuristic', `Sustained high motion with elevated audio for ${(ev.actionBins * STEP).toFixed(1)} s`);
  if (signals.unexpected != null && signals.unexpected >= 0.7) add('unexpected', 0.5 + (signals.unexpected - 0.7) * 0.5, 'heuristic', `Abrupt jump in audio/visual activity after a calmer stretch (unexpectedness ${(signals.unexpected * 100).toFixed(0)}%)`);
  if (score >= 85 && strong.length >= 3) add('epic', 0.52 + strong.length * 0.04, 'heuristic', `${strong.length} independent signals were strong at once (${strong.join(', ')})`);

  const enabled = new Set(settings.enabledCategories || CATEGORIES.map((c) => c.id));
  const valid = cands.filter((c) => enabled.has(c.id)).sort((a, b) => b.conf - a.conf);
  const best = valid[0];
  if (!best || best.conf < 0.48) {
    return { category: REVIEW.id, categoryConf: 0.3, method: 'uncertain', reasons: ['No category had enough supporting evidence — please review and set a category manually.'], evidence: ev, alternates: [] };
  }
  return { category: best.id, categoryConf: best.conf, method: best.method, reasons: [best.why], evidence: ev, alternates: valid.slice(1, 3).map((c) => ({ id: c.id, conf: c.conf })) };
}

/** Reasons drawn from raw numbers at the event (always shown, independent of category). */
export function explainSignals(tl, sig, region, signals) {
  const out = []; const A = tl.audio?.available ? tl.audio : null;
  const { peak } = region; const lo = Math.max(0, peak - 2), hi = Math.min(sig.n - 1, peak + 2);
  if (A && signals.audio != null && signals.audio >= 0.4) {
    let rise = 0, pk = -120; for (let i = lo; i <= hi; i++) { rise = Math.max(rise, at(sig.raw.rise, i)); pk = Math.max(pk, at(A.peakDb, i)); }
    out.push(`Audio rose ${rise.toFixed(0)} dB above the preceding ~8 s baseline (peak ${pk.toFixed(0)} dBFS).`);
  }
  const V = tl.visual?.available ? tl.visual : null;
  if (V && signals.visual != null && signals.visual >= 0.4) {
    let m = 0; for (let i = lo; i <= hi; i++) m = Math.max(m, at(V.motion, i));
    const ratio = sig.raw.motionMed > 0 ? m / sig.raw.motionMed : 0;
    const motionTxt = ratio >= 20 ? 'far above the recording’s typical level' : ratio >= 1.5 ? `${ratio.toFixed(1)}× the recording’s median` : 'above its baseline';
    out.push(`Frame-to-frame motion was ${motionTxt}.`);
  }
  if (signals.scene != null && signals.scene >= 0.5) out.push('Scene or lighting changed abruptly.');
  if (signals.speech != null && signals.speech >= 0.5) out.push(sig.raw.kw && Math.max(...Array.from(sig.raw.kw.slice(lo, hi + 1))) > 0 ? 'A configured reaction phrase was heard.' : 'Voice-band energy spiked (proxy for a vocal reaction).');
  if (signals.unexpected != null && signals.unexpected >= 0.5) out.push('This stands out against the calmer footage just before it.');
  return out;
}
