// Configurable keyboard shortcuts. Defaults follow common 3D-editor
// conventions; the user can rebind any action from the shortcuts dialog and
// bindings persist in local preferences.
import { t } from '../i18n/i18n.js';
import { loadPrefs, updatePrefs } from '../core/persistence.js';
import { customDialog } from './dialogs.js';

export const ACTIONS = [
  { id: 'file.save', cat: 'file', keys: ['ctrl+s'] },
  { id: 'file.saveAs', cat: 'file', keys: ['ctrl+shift+s'] },
  { id: 'app.search', cat: 'file', keys: ['ctrl+shift+p'] },
  { id: 'app.settings', cat: 'file', keys: ['ctrl+,'] },
  { id: 'tool.select', cat: 'tools', keys: ['q'] },
  { id: 'tool.move', cat: 'tools', keys: ['w', 'g'] },
  { id: 'tool.rotate', cat: 'tools', keys: ['e', 'r'] },
  { id: 'tool.scale', cat: 'tools', keys: ['s'] },
  { id: 'tool.displayEdit', cat: 'tools', keys: ['shift+e'] },
  { id: 'tool.toggleMoveRotate', cat: 'tools', keys: ['space'] },
  { id: 'tool.space', cat: 'tools', keys: ['t'] },
  { id: 'tool.snap', cat: 'tools', keys: ['o'] },
  { id: 'edit.undo', cat: 'edit', keys: ['ctrl+z'] },
  { id: 'edit.redo', cat: 'edit', keys: ['ctrl+y', 'ctrl+shift+z'] },
  { id: 'edit.delete', cat: 'edit', keys: ['delete', 'x'] },
  { id: 'edit.selectAll', cat: 'edit', keys: ['a', 'ctrl+a'] },
  { id: 'edit.deselect', cat: 'edit', keys: ['alt+a', 'escape'] },
  { id: 'edit.rename', cat: 'edit', keys: ['f2'] },
  { id: 'edit.add', cat: 'edit', keys: ['shift+a'] },
  { id: 'edit.parent', cat: 'edit', keys: ['ctrl+p'] },
  { id: 'edit.unparent', cat: 'edit', keys: ['alt+p'] },
  { id: 'anim.play', cat: 'anim', keys: ['shift+space', 'k'] },
  { id: 'anim.stepBack', cat: 'anim', keys: ['arrowleft'] },
  { id: 'anim.stepForward', cat: 'anim', keys: ['arrowright'] },
  { id: 'anim.jumpStart', cat: 'anim', keys: ['shift+arrowleft', 'home'] },
  { id: 'anim.jumpEnd', cat: 'anim', keys: ['shift+arrowright', 'end'] },
  { id: 'anim.insertKey', cat: 'anim', keys: ['i'] },
  { id: 'anim.autoKey', cat: 'anim', keys: ['ctrl+k'] },
  { id: 'anim.copyKeys', cat: 'anim', keys: ['ctrl+c'] },
  { id: 'anim.pasteKeys', cat: 'anim', keys: ['ctrl+v'] },
  { id: 'anim.duplicateKeys', cat: 'anim', keys: ['shift+d'] },
  { id: 'view.frameSelected', cat: 'view', keys: ['f', 'numpad.'] },
  { id: 'view.frameAll', cat: 'view', keys: ['shift+f', 'shift+home'] },
  { id: 'view.projection', cat: 'view', keys: ['numpad5', 'p'] },
  { id: 'view.front', cat: 'view', keys: ['numpad1'] },
  { id: 'view.back', cat: 'view', keys: ['ctrl+numpad1'] },
  { id: 'view.right', cat: 'view', keys: ['numpad3'] },
  { id: 'view.left', cat: 'view', keys: ['ctrl+numpad3'] },
  { id: 'view.top', cat: 'view', keys: ['numpad7'] },
  { id: 'view.bottom', cat: 'view', keys: ['ctrl+numpad7'] },
  { id: 'view.wasd', cat: 'view', keys: ['ctrl+shift+w'] },
];

let bindings = null;
function load() {
  if (bindings) return bindings;
  const saved = loadPrefs().shortcuts || {};
  // migration: plain Space now toggles Move/Rotate in the viewport
  if (Array.isArray(saved['anim.play']) && saved['anim.play'].includes('space') && !saved['tool.toggleMoveRotate']) delete saved['anim.play'];
  bindings = new Map(ACTIONS.map((a) => [a.id, saved[a.id] || a.keys.slice()]));
  return bindings;
}
export function keysFor(id) { return load().get(id) || []; }
export function primaryKeyLabel(id) { return formatKey(keysFor(id)[0] || ''); }

export function eventKey(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = e.key.toLowerCase();
  if (k === ' ') k = 'space';
  if (e.code && e.code.startsWith('Numpad')) k = 'numpad' + (e.code === 'NumpadDecimal' ? '.' : e.code.slice(6).toLowerCase());
  if (['control', 'shift', 'alt', 'meta'].includes(k)) return null;
  parts.push(k);
  return parts.join('+');
}

export function matchAction(e) {
  const key = eventKey(e);
  if (!key) return null;
  for (const [id, keys] of load()) if (keys.includes(key)) return id;
  return null;
}

export function formatKey(k) {
  if (!k) return '';
  return k.split('+').map((p) => {
    if (p === 'ctrl') return 'Ctrl'; if (p === 'shift') return 'Shift'; if (p === 'alt') return 'Alt';
    if (p === 'space') return 'Space'; if (p === 'delete') return 'Del'; if (p === 'escape') return 'Esc';
    if (p.startsWith('arrow')) return { arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' }[p];
    if (p.startsWith('numpad')) return 'Num ' + p.slice(6);
    return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
  }).join('+');
}

export function setBinding(id, keys) {
  load().set(id, keys);
  const obj = {};
  for (const [k, v] of bindings) obj[k] = v;
  updatePrefs({ shortcuts: obj });
}

export function resetBindings() {
  bindings = new Map(ACTIONS.map((a) => [a.id, a.keys.slice()]));
  updatePrefs({ shortcuts: {} });
}

export function showShortcutsDialog() {
  const body = document.createElement('div');
  const info = document.createElement('p');
  info.className = 'hint';
  info.textContent = t('sc.help');
  body.appendChild(info);
  const table = document.createElement('table');
  table.className = 'sc-table';
  const render = () => {
    table.innerHTML = '';
    let lastCat = null;
    for (const a of ACTIONS) {
      if (a.cat !== lastCat) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 2; td.className = 'cat'; td.textContent = t('sc.cat.' + a.cat);
        tr.appendChild(td); table.appendChild(tr); lastCat = a.cat;
      }
      const tr = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = t('sc.' + a.id);
      const key = document.createElement('td'); key.className = 'key';
      const keys = keysFor(a.id);
      const kbd = document.createElement('kbd');
      kbd.textContent = keys.map(formatKey).join(' / ') || '—';
      kbd.title = t('sc.rebind');
      kbd.addEventListener('click', () => {
        kbd.classList.add('recording'); kbd.textContent = t('sc.press');
        const onKey = (e) => {
          e.preventDefault(); e.stopPropagation();
          const k = eventKey(e);
          if (!k) return;
          window.removeEventListener('keydown', onKey, true);
          if (k !== 'escape') setBinding(a.id, [k, ...keys.slice(1)]);
          render();
        };
        window.addEventListener('keydown', onKey, true);
      });
      key.appendChild(kbd);
      tr.append(name, key);
      table.appendChild(tr);
    }
  };
  render();
  body.appendChild(table);
  const extra = document.createElement('p');
  extra.className = 'hint';
  extra.textContent = t('sc.mouse');
  body.appendChild(extra);
  return customDialog({
    title: t('sc.title'), body,
    buttons: [
      { label: t('sc.reset'), value: () => { resetBindings(); return 'reset'; } },
      { label: t('btn.close'), primary: true, value: () => true },
    ],
  });
}
