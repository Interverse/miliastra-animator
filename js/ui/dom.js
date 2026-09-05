// Tiny DOM builders shared by the panels.
import { t } from '../i18n/i18n.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

export function row(label, control, tip) {
  const r = h('div', { class: 'row', title: tip || null }, h('span', { text: label }), control);
  return r;
}

export function numInput(value, onChange, { step = 0.01, min, max, width, precision = 3, live = false } = {}) {
  const inp = h('input', { type: 'number', step, value: fmt(value, precision) });
  if (min != null) inp.min = min;
  if (max != null) inp.max = max;
  if (width) inp.style.width = width + 'px';
  const fire = (commit) => {
    const v = parseFloat(inp.value);
    if (Number.isNaN(v)) return;
    let c = v;
    if (min != null) c = Math.max(min, c);
    if (max != null) c = Math.min(max, c);
    onChange(c, commit);
  };
  inp.addEventListener('change', () => fire(true));
  if (live) inp.addEventListener('input', () => fire(false));
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { fire(true); inp.blur(); } });
  // drag to scrub values with the wheel while focused
  inp.addEventListener('wheel', (e) => { if (document.activeElement !== inp) return; e.preventDefault(); const v = parseFloat(inp.value) || 0; inp.value = fmt(v - Math.sign(e.deltaY) * step * (e.shiftKey ? 10 : 1), precision); fire(true); }, { passive: false });
  return inp;
}

export function fmt(v, precision = 3) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '0';
  const s = v.toFixed(precision);
  return String(parseFloat(s));
}

export function vec3Row(label, values, onChange, { step = 0.01, precision = 3, classes = null, tip, live = false, min, max } = {}) {
  const inputs = ['x', 'y', 'z'].map((ax, i) => {
    const inp = numInput(values[i], (v, commit) => { const arr = inputs.map((x) => parseFloat(x.value) || 0); arr[i] = v; onChange(arr, i, commit); }, { step, precision, live, min, max });
    inp.classList.add('axis-' + ax);
    if (classes && classes[i]) inp.classList.add(classes[i]);
    inp.title = ax.toUpperCase();
    return inp;
  });
  const r = h('div', { class: 'row-triple', title: tip || null }, h('span', { text: label }), ...inputs);
  r.inputs = inputs;
  return r;
}

export function textInput(value, onChange, { placeholder = '' } = {}) {
  const inp = h('input', { type: 'text', value, placeholder });
  inp.addEventListener('change', () => onChange(inp.value));
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { onChange(inp.value); inp.blur(); } if (e.key === 'Escape') inp.blur(); });
  return inp;
}

export function selectInput(options, value, onChange, { width } = {}) {
  const sel = h('select');
  for (const o of options) sel.append(h('option', { value: o.value, text: o.label, selected: String(o.value) === String(value), disabled: o.disabled || null }));
  sel.addEventListener('change', () => onChange(sel.value));
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  if (width) sel.style.width = width + 'px';
  return sel;
}

export function checkbox(label, checked, onChange, tip) {
  const inp = h('input', { type: 'checkbox', checked: !!checked });
  inp.addEventListener('change', () => onChange(inp.checked));
  return h('label', { class: 'toggle-row', title: tip || null }, inp, h('span', { text: label }));
}

export function button(label, onClick, { cls = 'mini', tip, disabled = false, icon } = {}) {
  const b = h('button', { class: cls, title: tip || null, disabled: disabled || null, onclick: (e) => { e.stopPropagation(); onClick(e); } });
  if (icon) b.append(h('span', { text: icon + ' ' }));
  b.append(document.createTextNode(label));
  return b;
}

export function btnRow(...buttons) { return h('div', { class: 'btn-row' }, ...buttons); }
export function subhead(text, ...extra) { return h('div', { class: 'subhead' }, h('span', { text }), ...extra); }
export function hint(text, cls = '') { return h('div', { class: 'hint ' + cls, text }); }
export function empty(text) { return h('div', { class: 'empty', text }); }

export function slider(value, onChange, { min = 0, max = 1, step = 0.01 } = {}) {
  const inp = h('input', { type: 'range', min, max, step, value });
  inp.addEventListener('input', () => onChange(parseFloat(inp.value), false));
  inp.addEventListener('change', () => onChange(parseFloat(inp.value), true));
  return inp;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// Preserve scroll position of a panel body across re-render
export function rerender(body, buildFn) {
  const scrollTop = body.scrollTop;
  const focusId = document.activeElement?.dataset?.focusId;
  clear(body);
  buildFn(body);
  body.scrollTop = scrollTop;
  if (focusId) body.querySelector(`[data-focus-id="${focusId}"]`)?.focus();
}
