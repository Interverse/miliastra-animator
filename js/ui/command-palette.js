// Command palette: type part of a localized command name (or a keyword) and run it.
// Opened with the 🔍 button or Ctrl+Shift+P. Small, top-centred, closes on Escape / blur.
import { t } from '../i18n/i18n.js';
import { h } from './dom.js';
import { buildCommands, COMMAND_GROUPS } from './commands.js';

export function showCommandPalette(ctx) {
  document.getElementById('cmd-palette')?.remove();
  // unavailable commands (e.g. bone-only actions with nothing selected) stay listed but disabled
  const cmds = buildCommands(ctx);
  const avail = (c) => !c.when || c.when();
  const root = h('div', { id: 'cmd-palette', role: 'dialog', 'aria-label': t('palette.title') });
  const input = h('input', { type: 'text', placeholder: t('palette.placeholder'), 'aria-label': t('palette.title') });
  const list = h('div', { class: 'cmd-list' });
  let items = [], sel = 0;
  const norm = (s) => String(s || '').toLowerCase();
  const render = () => {
    const q = norm(input.value).trim();
    items = cmds.filter((c) => !q || norm(c.label()).includes(q) || norm(c.keywords).includes(q) || norm(t('cmd.group.' + c.group)).includes(q)).slice(0, 14);
    list.innerHTML = '';
    if (!items.length) { list.append(h('div', { class: 'cmd-empty', text: t('palette.empty') })); return; }
    sel = Math.min(sel, items.length - 1);
    items.forEach((c, i) => {
      const row = h('div', { class: 'cmd-item' + (i === sel ? ' sel' : '') + (avail(c) ? '' : ' off'), role: 'option', 'aria-disabled': avail(c) ? null : 'true' },
        h('span', { class: 'cmd-group', text: t('cmd.group.' + c.group) }),
        h('span', { class: 'cmd-label', text: (c.checked ? (c.checked() ? '✓ ' : '○ ') : '') + c.label() }),
        h('span', { class: 'cmd-key', text: avail(c) ? c.shortcut() : t('palette.unavailable') }));
      row.addEventListener('pointerdown', (e) => { e.preventDefault(); run(c); });
      list.append(row);
    });
  };
  const close = () => { root.remove(); window.removeEventListener('pointerdown', outside, true); };
  const run = (c) => { if (!avail(c)) return; close(); try { c.run(); } catch (e) { console.error(e); } };
  const outside = (e) => { if (!root.contains(e.target)) close(); };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) run(items[sel]); }
  });
  root.append(input, list, h('div', { class: 'cmd-hint', text: t('palette.hint') }));
  document.body.appendChild(root);
  render();
  input.focus();
  setTimeout(() => window.addEventListener('pointerdown', outside, true), 0);
  void COMMAND_GROUPS;
  return root;
}
