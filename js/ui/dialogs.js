// Site-styled dialogs (prompt / confirm / message / custom) and toasts.
import { t } from '../i18n/i18n.js';
import { BackdropGuard } from './backdrop-guard.js';

import { onLangChange } from '../i18n/i18n.js';
import { placePopover } from './popover-place.js';

const val = (x, ...a) => (typeof x === 'function' ? x(...a) : x);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// title, body and button labels may be functions: they are re-evaluated when the language
// changes while the dialog is open (the body is rebuilt in place, buttons relabelled), so a
// dialog never shows stale text — including the Settings dialog the language is changed from.
function makeDialog({ title, body, buttons, setup = null }) {
  const dlg = document.createElement('dialog');
  const head = el('div', 'dlg-head', val(title));
  const bodyEl = el('div', 'dlg-body');
  const fillBody = () => { bodyEl.innerHTML = ''; const b = val(body); if (typeof b === 'string') bodyEl.textContent = b; else if (b) bodyEl.append(b); };
  fillBody();
  const foot = el('div', 'dlg-foot');
  dlg.append(head, bodyEl, foot);
  document.body.appendChild(dlg);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; offLang(); try { dlg.close(); } catch {} dlg.dispatchEvent(new Event('close')); dlg.remove(); resolve(v); };
    const btns = [];
    for (const b of buttons) {
      const btn = el('button', b.cls || 'secondary', val(b.label));
      btn.addEventListener('click', () => finish(b.value(bodyEl)));
      foot.appendChild(btn); btns.push([btn, b]);
      if (b.primary) btn.classList.remove('secondary');
    }
    const offLang = onLangChange(() => {
      head.textContent = val(title);
      for (const [btn, b] of btns) btn.textContent = val(b.label);
      if (typeof body === 'function') fillBody();
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!guard.blocked) finish(null); });
    // backdrop click = genuine pointerdown + pointerup on the backdrop; drags that end over it,
    // file drags, lost pointer capture, blur and tab switches never close the dialog
    const guard = new BackdropGuard();
    dlg.addEventListener('pointerdown', (e) => guard.pointerDown(e.target === dlg));
    dlg.addEventListener('pointerup', (e) => guard.pointerUp(e.target === dlg));
    dlg.addEventListener('pointercancel', () => guard.interrupt());
    dlg.addEventListener('lostpointercapture', () => guard.interrupt());
    dlg.addEventListener('click', (e) => { if (guard.click(e.target === dlg)) finish(null); });
    const onBlur = () => guard.interrupt();
    const onVis = () => guard.interrupt();
    const onDrag = (e) => { if (e.type === 'drop' || e.type === 'dragend' || (e.type === 'dragleave' && !e.relatedTarget)) guard.dragEnd(); else guard.dragStart(); };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) window.addEventListener(type, onDrag, true);
    const cleanup = () => { window.removeEventListener('blur', onBlur); document.removeEventListener('visibilitychange', onVis); for (const type of ['dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) window.removeEventListener(type, onDrag, true); };
    dlg.addEventListener('close', cleanup);
    dlg.__guard = guard;
    if (setup) setup(dlg, finish);
    dlg.showModal();
    const inp = bodyEl.querySelector('input,select,textarea');
    if (inp) { inp.focus(); if (inp.select) inp.select(); }
    bodyEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); const primary = buttons.find((b) => b.primary); if (primary) finish(primary.value(bodyEl)); }
    });
  });
}

export function textPrompt({ title, label = '', value = '' } = {}) {
  const body = el('div');
  if (label) body.append(el('p', null, label));
  const input = el('input');
  input.type = 'text'; input.value = value;
  body.append(input);
  return makeDialog({
    title, body,
    buttons: [
      { label: t('btn.cancel'), value: () => null },
      { label: t('btn.ok'), primary: true, value: () => input.value.trim() || null },
    ],
  });
}

export function confirmDialog({ title, message, okLabel, danger = false } = {}) {
  return makeDialog({
    title, body: message,
    buttons: [
      { label: t('btn.cancel'), value: () => false },
      { label: okLabel || t('btn.ok'), primary: true, cls: danger ? 'danger' : '', value: () => true },
    ],
  }).then((v) => !!v);
}

export function messageDialog({ title, message, body } = {}) {
  return makeDialog({ title, body: body || message, buttons: [{ label: t('btn.ok'), primary: true, value: () => true }] });
}

export function customDialog({ title, body, buttons, setup = null }) {
  return makeDialog({ title, body, buttons, setup });
}

let toastTimer = null;
export function toast(message, kind = 'success', ms = 2600) {
  if (typeof document === 'undefined') return; // headless (tests)
  const host = document.getElementById('toasts');
  if (!host) return;
  const item = el('div', 'toast' + (kind !== 'success' ? ' ' + kind : ''), message);
  host.appendChild(item);
  setTimeout(() => { item.style.transition = 'opacity .18s'; item.style.opacity = '0'; setTimeout(() => item.remove(), 200); }, ms);
  return item;
}

// Simple contextual menu anchored to an element; items: [{label, action, disabled, head, sep}]
// Menus render in the fixed overlay layer (document.body, --z-popover), never inside the
// toolbar or panel that opened them, so no stacking context, overflow or canvas can cover
// or clip them. `anchor` is an element (menu below it, flipped above when there is more room)
// or a pointer { x, y } (context menus). Closed by an outside pointerdown — which is swallowed,
// so closing a menu never starts a drag underneath — Escape, window blur, resize or scroll.
export function showMenu(anchor, items) {
  closeMenus();
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.sep) { menu.appendChild(el('div', 'sep')); continue; }
    if (it.head) { menu.appendChild(el('div', 'menu-head', it.head)); continue; }
    const b = el('button', null);
    b.setAttribute('role', 'menuitem');
    const icon = it.checked === true ? '✓' : it.checked === false ? '' : (it.icon || '');
    b.append(el('span', 'menu-ico', icon), el('span', 'menu-label', it.label));
    if (it.key) b.append(el('span', 'menu-key', it.key));
    if (it.checked != null) b.classList.add(it.checked ? 'checked' : 'unchecked');
    if (it.disabled) b.disabled = true;
    if (it.tip) b.title = it.tip;
    b.addEventListener('click', () => { close(); it.action?.(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const position = () => {
    const a = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { x: anchor?.x ?? 0, y: anchor?.y ?? 0 };
    const pos = placePopover(a, { w: menu.offsetWidth, h: menu.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
    menu.style.left = pos.left + 'px'; menu.style.top = pos.top + 'px';
    menu.classList.toggle('flipped', pos.flipped);
  };
  position();
  const onDown = (e) => { if (menu.contains(e.target)) return; e.preventDefault(); e.stopPropagation(); close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const onScroll = (e) => { if (!menu.contains(e.target)) position(); };
  const close = () => {
    menu.remove();
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    document.removeEventListener('scroll', onScroll, true);
  };
  menu.__close = close;
  setTimeout(() => {
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', onScroll, true);
  }, 0);
  return menu;
}
export function closeMenus() { document.querySelectorAll('.menu').forEach((m) => (m.__close ? m.__close() : m.remove())); }
