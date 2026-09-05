// Site-styled dialogs (prompt / confirm / message / custom) and toasts.
import { t } from '../i18n/i18n.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function makeDialog({ title, body, buttons }) {
  const dlg = document.createElement('dialog');
  const head = el('div', 'dlg-head', title);
  const bodyEl = el('div', 'dlg-body');
  if (typeof body === 'string') bodyEl.textContent = body; else if (body) bodyEl.append(body);
  const foot = el('div', 'dlg-foot');
  dlg.append(head, bodyEl, foot);
  document.body.appendChild(dlg);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { dlg.close(); } catch {} dlg.remove(); resolve(v); };
    for (const b of buttons) {
      const btn = el('button', b.cls || 'secondary', b.label);
      btn.addEventListener('click', () => finish(b.value(bodyEl)));
      foot.appendChild(btn);
      if (b.primary) btn.classList.remove('secondary');
    }
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(null); });
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

export function customDialog({ title, body, buttons }) {
  return makeDialog({ title, body, buttons });
}

let toastTimer = null;
export function toast(message, kind = 'success', ms = 2600) {
  if (typeof document === 'undefined') return; // headless (tests)
  const host = document.getElementById('toasts');
  if (!host) return;
  const item = el('div', 'toast' + (kind !== 'success' ? ' ' + kind : ''), message);
  host.appendChild(item);
  setTimeout(() => { item.style.transition = 'opacity .18s'; item.style.opacity = '0'; setTimeout(() => item.remove(), 200); }, ms);
}

// Simple contextual menu anchored to an element; items: [{label, action, disabled, head, sep}]
export function showMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = el('div', 'menu');
  for (const it of items) {
    if (it.sep) { menu.appendChild(el('div', 'sep')); continue; }
    if (it.head) { menu.appendChild(el('div', 'menu-head', it.head)); continue; }
    const b = el('button', null);
    b.append(el('span', null, it.icon || ''), el('span', null, it.label));
    if (it.disabled) b.disabled = true;
    b.addEventListener('click', () => { menu.remove(); it.action?.(); });
    menu.appendChild(b);
  }
  const host = anchor.closest('.tb-group') || anchor.parentElement;
  host.style.position = 'relative';
  host.appendChild(menu);
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); window.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => window.addEventListener('pointerdown', close, true), 0);
  return menu;
}
