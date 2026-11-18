// Shared helpers: DOM, formatting, math, toasts, modals, object URLs.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/** Tiny hyperscript. h('div',{class:'x',onclick:fn},'text',child) */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const icon = (name, cls = '') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'ic ' + cls);
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `assets/icons/sprite.svg#i-${name}`);
  s.appendChild(u);
  return s;
};
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = (p = 'id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

export function fmtTime(sec, ms = false) {
  if (!isFinite(sec)) return '--:--';
  sec = Math.max(0, sec);
  const h_ = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const base = (h_ ? h_ + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  return ms ? base + '.' + String(Math.floor((sec % 1) * 1000)).padStart(3, '0') : base;
}
export function fmtDur(sec) {
  if (!isFinite(sec) || sec <= 0) return '0s';
  if (sec < 60) return Math.round(sec) + 's';
  const h_ = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return (h_ ? h_ + 'h ' : '') + (m ? m + 'm ' : '') + (!h_ && s ? s + 's' : '');
}
export function fmtBytes(b) {
  if (b == null || isNaN(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(b >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}
export function fmtDate(ts) { return ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }

// Robust statistics
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
export function sortedCopy(a) { return Float64Array.from(a).sort(); }
export function percentile(a, p) {
  if (!a.length) return 0;
  const s = sortedCopy(a); const i = clamp((s.length - 1) * p, 0, s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const median = (a) => percentile(a, 0.5);
export function mad(a, med = median(a)) { return median(Array.from(a, (x) => Math.abs(x - med))); }

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function safeName(s, fallback = 'clip') {
  return (String(s || fallback).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60)) || fallback;
}

/** Tracks object URLs so they can be revoked (memory hygiene). */
export class UrlManager {
  constructor() { this.urls = new Set(); }
  create(blob) { const u = URL.createObjectURL(blob); this.urls.add(u); return u; }
  revoke(u) { if (this.urls.delete(u)) URL.revokeObjectURL(u); }
  revokeAll() { this.urls.forEach((u) => URL.revokeObjectURL(u)); this.urls.clear(); }
}

// Event bus
const listeners = new Map();
export const bus = {
  on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev)?.delete(fn); },
  emit(ev, data) { listeners.get(ev)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
};

// Toasts
export function toast(msg, type = 'info', ms = 4200) {
  const host = $('#toast-host'); if (!host) return;
  const ico = { success: 'check', error: 'warn', warn: 'warn', info: 'help' }[type] || 'help';
  const el = h('div', { class: 'toast ' + type, role: 'status' }, icon(ico), h('div', {}, msg));
  host.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// Modals
export function modal({ title, body, footer, wide = false, onClose } = {}) {
  const host = $('#modal-host');
  const close = () => { host.classList.remove('open'); host.innerHTML = ''; document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    h('div', { class: 'modal-head' }, h('h2', {}, title || ''), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  host.innerHTML = ''; host.append(box); host.classList.add('open');
  host.onclick = (e) => { if (e.target === host) close(); };
  document.addEventListener('keydown', onKey);
  return { close, el: box };
}
export function confirmDialog(title, message, { okText = 'Confirm', danger = false, cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const m = modal({
      title, body: h('div', { class: 'stack' }, typeof message === 'string' ? h('p', { class: 'muted' }, message) : message),
      footer: [h('button', { class: 'btn', onclick: () => fin(false) }, cancelText), h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => fin(true) }, okText)],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}
export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'text', value, 'aria-label': label });
    const fin = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fin(input.value.trim() || null); });
    const m = modal({
      title, body: h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input),
      footer: [h('button', { class: 'btn', onclick: () => fin(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => fin(input.value.trim() || null) }, 'Save')],
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// Tooltips (data-tip)
export function initTooltips() {
  const tip = $('#tip');
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('[data-tip]'); if (!t) return;
    tip.textContent = t.dataset.tip; tip.classList.add('show');
    const r = t.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - 290, Math.max(8, r.left + r.width / 2 - 100)) + 'px';
    tip.style.top = (r.bottom + 8) + 'px';
  });
  document.addEventListener('mouseout', (e) => { if (e.target.closest?.('[data-tip]')) tip.classList.remove('show'); });
  document.addEventListener('click', () => tip.classList.remove('show'));
}

export function scoreClass(score) {
  return score >= 90 ? 'exceptional' : score >= 80 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'average' : 'low';
}
export function scoreLabel(score) {
  return { exceptional: 'Exceptional', excellent: 'Excellent', good: 'Good', average: 'Average', low: 'Low Potential' }[scoreClass(score)];
}
export const scoreBadge = (s) => h('span', { class: 'score-badge score-' + scoreClass(s), 'data-tip': scoreLabel(s) + ' engagement potential (heuristic)' }, Math.round(s));

export function emptyState(iconName, title, text, actions = []) {
  return h('div', { class: 'empty' }, icon(iconName), h('h3', {}, title), h('p', {}, text), actions.length ? h('div', { class: 'row', style: { justifyContent: 'center' } }, actions) : null);
}

/** Wait for a media event with timeout. */
export function once(el, ev, timeout = 15000, errEv = 'error') {
  return new Promise((res, rej) => {
    const ok = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(new Error(el.error?.message || 'Media error')); };
    const t = setTimeout(() => { cleanup(); rej(new Error('Timed out waiting for ' + ev)); }, timeout);
    const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener(errEv, bad); };
    el.addEventListener(ev, ok); el.addEventListener(errEv, bad);
  });
}
export async function seekTo(video, t, timeout = 8000) {
  t = clamp(t, 0, Math.max(0, (video.duration || 1e9) - 0.001));
  if (Math.abs(video.currentTime - t) < 0.002 && video.readyState >= 2) return;
  const p = once(video, 'seeked', timeout); video.currentTime = t; await p;
}

/** Load a <video> ready for decoding. Fixes Infinity duration on MediaRecorder WebM files. */
export async function loadVideo(url, { muted = true, timeout = 25000 } = {}) {
  const v = document.createElement('video');
  v.muted = muted; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await once(v, 'loadedmetadata', timeout);
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await new Promise((res) => { const t = setTimeout(res, 4000); v.addEventListener('timeupdate', () => { clearTimeout(t); res(); }, { once: true }); });
    if (isFinite(v.duration)) { const p = once(v, 'seeked', 8000).catch(() => {}); v.currentTime = 0; await p; }
  }
  if (v.readyState < 2) await once(v, 'loadeddata', timeout).catch(() => {});
  return v;
}
export function disposeVideo(v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }
