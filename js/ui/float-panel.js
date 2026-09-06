// Non-blocking preview panels. A Preview action shows the proposed result in the normal
// 3D viewport; the controls live in a compact floating panel that never covers the model:
// no backdrop, camera navigation and the timeline stay usable, the panel is draggable
// (position remembered per key for the session), collapsible, kept inside the window,
// and closed automatically when the project changes. Same contract as customDialog:
// resolves with the clicked button's value, or null when closed / cancelled.
import { t } from '../i18n/i18n.js';
import { h } from './dom.js';

const positions = new Map(); // key → { left, top } (session only)
const open = new Set();
const listeners = new Set();
const notify = () => { for (const fn of listeners) fn(open.size); };
export function onPreviewPanels(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const previewPanelCount = () => open.size;

function defaultPosition(width) {
  const vp = document.getElementById('viewport')?.getBoundingClientRect();
  // hug the window's right edge (over the right sidebar, not the viewport), below the toolbar;
  // the model usually sits in the viewport's centre-left, which stays clear
  return { left: Math.max(8, window.innerWidth - width - 12), top: Math.max(8, (vp?.top ?? 60) + 8) };
}
// panels never take more than 40 % of a small window so the viewport stays usable
const panelWidth = (w) => Math.max(260, Math.min(w, Math.floor(window.innerWidth * 0.4), window.innerWidth - 24));
function clampTo(el, pos) {
  const w = el.offsetWidth || 320, hgt = el.offsetHeight || 200;
  return { left: Math.min(Math.max(4, pos.left), Math.max(4, window.innerWidth - w - 4)), top: Math.min(Math.max(4, pos.top), Math.max(4, window.innerHeight - Math.min(hgt, 120) - 4)) };
}

export function floatingPanel({ key = 'preview', title, body, buttons = [], setup = null, width = 360 }) {
  return new Promise((resolve) => {
    const el = h('div', { class: 'float-panel', role: 'dialog', 'aria-label': title });
    el.style.width = panelWidth(width) + 'px';
    const collapseBtn = h('button', { class: 'fp-icon', text: '–', title: t('preview.collapse') });
    const closeBtn = h('button', { class: 'fp-icon', text: '✕', title: t('preview.close') });
    const head = h('div', { class: 'fp-head' }, h('span', { class: 'fp-title', text: title }), h('span', { class: 'chip fp-chip', text: t('preview.mode') }), collapseBtn, closeBtn);
    const bodyEl = h('div', { class: 'fp-body' });
    if (typeof body === 'string') bodyEl.textContent = body; else if (body) bodyEl.append(body);
    const foot = h('div', { class: 'fp-foot' });
    let done = false;
    const rec = { el, finish: null };
    const finish = (v) => {
      if (done) return; done = true;
      open.delete(rec);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey, true);
      el.remove();
      notify();
      resolve(v);
    };
    rec.finish = finish;
    for (const b of buttons) {
      const btn = h('button', { class: b.primary ? '' : 'secondary', text: b.label });
      btn.addEventListener('click', () => finish(b.value(bodyEl)));
      foot.append(btn);
    }
    closeBtn.addEventListener('click', () => finish(null));
    collapseBtn.addEventListener('click', () => { const c = el.classList.toggle('collapsed'); collapseBtn.textContent = c ? '+' : '–'; collapseBtn.title = t(c ? 'preview.expand' : 'preview.collapse'); });
    el.append(head, bodyEl, foot);
    document.body.appendChild(el);
    // position: remembered for this session, else the viewport's top-right corner; always inside the window
    const place = (pos) => { const p = clampTo(el, pos); el.style.left = p.left + 'px'; el.style.top = p.top + 'px'; positions.set(key, p); };
    place(positions.get(key) || defaultPosition(el.offsetWidth));
    const onResize = () => { el.style.width = panelWidth(width) + 'px'; place(positions.get(key) || defaultPosition(el.offsetWidth)); };
    window.addEventListener('resize', onResize);
    // drag by the header
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop };
      const move = (ev) => place({ left: start.left + ev.clientX - start.x, top: start.top + ev.clientY - start.y });
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); try { head.releasePointerCapture(e.pointerId); } catch {} };
      try { head.setPointerCapture(e.pointerId); } catch {}
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
      e.preventDefault();
    });
    // Escape closes the panel only while the focus is inside it (viewport shortcuts keep working)
    const onKey = (e) => { if (e.key === 'Escape' && el.contains(document.activeElement)) { e.stopPropagation(); finish(null); } };
    document.addEventListener('keydown', onKey, true);
    open.add(rec);
    notify();
    if (setup) setup(el, finish);
    const inp = bodyEl.querySelector('input,select,button');
    if (inp) inp.focus({ preventScroll: true });
  });
}
// Close every open preview panel (project switch, New Project): each one resolves null,
// so its owner runs the normal cancel path and removes its temporary state.
export function closeFloatingPanels() { for (const r of [...open]) r.finish(null); }
