// Graph Editor / Curve Editor: one curve per animated channel component (Position X/Y/Z,
// Rotation X/Y/Z of bones, objects, IK targets and poles) drawn over time, with editable
// points and tangent handles. It edits the SAME clip tracks as the Dope Sheet through the
// editor's key methods; there is no separate curve data. Shares the transport, playhead,
// selection and Auto Key with the timeline; lives in the timeline area (mode switch in its
// header).
import { t, onLangChange } from '../i18n/i18n.js';
import { h, numInput, checkbox, fmt } from './dom.js';
import { showMenu, customDialog } from './dialogs.js';
import { activeClip, clipEnd, INTERPOLATIONS, snapTime, keyTimes, keyRef } from '../anim/clips.js';
import { channelsOf, trackEuler, pointRef, parsePointRef, HANDLE_MODES, evaluateComponent } from '../anim/curves.js';
import { orderedNodes, getNode } from '../scene/scene.js';
import { xOf, yOf, timeAt, valueAt, fitView, niceStep, sampleChannel, hitPoint, pointsInBox } from './graph-geom.js';
import { keyRange, fitTimeRange } from './timeline-fit.js';

const RULER_H = 22, AXIS_W = 46;
const AXIS_COLORS = ['#e0605e', '#6fd07a', '#5ea0ff'];          // X, Y, Z (as the transform fields)
const ROT_COLORS = ['#f2a3a1', '#b7ecbf', '#b3d0ff'];           // rotation: lighter tint of the same axis
const ICONS = { object: '▣', bone: '⌇', proxy: '◇', target: '⊕', pole: '◎' };

export class GraphEditor {
  constructor(editor, container) {
    this.editor = editor;
    this.container = container;
    this.tools = container.querySelector('#graph-tools');
    this.list = container.querySelector('#graph-channels');
    this.canvas = container.querySelector('#graph-canvas');
    this.emptyEl = container.querySelector('#graph-empty');
    this.ctx = this.canvas.getContext('2d');
    this.view = { t0: -0.15, pxPerSec: 160, vCenter: 0, pxPerUnit: 60, left: AXIS_W, top: RULER_H, w: 0, h: 0 };
    this.snap = { frames: true, keys: false, values: false };
    this.selChannels = new Set();  // channel ids picked in the list (Frame selected, insert key)
    this.points = []; this.handles = []; this.curves = [];
    this.cache = new Map();
    this.drag = null; this.hover = null; this.activePoint = null;
    this._listKey = '';
    // The filter field is created once and never rebuilt: only the channel rows below it are
    // re-rendered, so typing keeps focus, caret and selection. Typing is plain input (the
    // global shortcut handler ignores editable elements).
    this.search = h('input', { type: 'search', class: 'graph-search', placeholder: t('graph.search'), title: t('tip.graph.search'), 'aria-label': t('graph.search') });
    this.search.addEventListener('input', () => { this.ui.filter = this.search.value; editor.scheduleSave(); this.refreshList(true); this.draw(); });
    this.listHead = h('div', { id: 'graph-channels-head' }, this.search);
    this.rows = h('div', { class: 'gc-rows' });
    this.list.append(this.listHead, this.rows);
    this.framedClip = undefined; // the Graph frames the animation on its own when a different clip becomes active
    editor.on('project', () => { this.framedClip = undefined; });
    this.buildTools();
    this.bind();
    new ResizeObserver(() => this.resize()).observe(container.querySelector('#graph-plot'));
    editor.on('change', (d) => { if (!d?.transient) this.cache.clear(); if (!d?.transient || d.time) this.syncFields(); this.refreshList(); this.draw(); });
    editor.on('time', () => { this.syncFields(); this.draw(); });
    editor.on('keys', () => { this.syncFields(); this.refreshList(); this.draw(); });
    editor.on('selection', () => { this.refreshList(); this.draw(); });
    editor.on('graphui', () => { this.refreshList(true); this.syncTools(); this.draw(); });
    onLangChange(() => { this.buildTools(); this.refreshList(true); this.draw(); });
  }
  get ui() { return this.editor.graphUI; }
  get visible() { return !this.container.hidden; }

  // ---------- toolbar (graph-specific; transport etc. stay in the shared timeline header) ----------
  buildTools() {
    const ed = this.editor;
    this.tools.innerHTML = '';
    const tb = (label, tip, onClick, cls = '') => h('button', { class: 'tb-btn ' + cls, text: label, title: tip, onclick: onClick });
    const viewGroup = h('div', { class: 'tb-group' },
      (this.normBtn = tb(t('graph.normalize'), t('tip.graph.normalize'), () => ed.setGraphUI({ normalize: !this.ui.normalize }))),
      tb(t('graph.frameSel'), t('tip.graph.frameSel'), () => this.frameSelected()),
      tb(t('graph.frameAll'), t('tip.graph.frameAll'), () => this.frameAll()),
      tb(t('graph.frameClip'), t('tip.graph.frameClip'), () => this.frameClip()),
      tb('↺', t('tip.graph.resetView'), () => this.resetView()),
    );
    const snapGroup = h('div', { class: 'tb-group', title: t('tip.graph.snap') },
      h('span', { class: 'tb-label', text: t('graph.snap') }),
      (this.snapF = tb(t('graph.snapFrames'), t('tip.graph.snapFrames'), () => { this.snap.frames = !this.snap.frames; this.syncTools(); })),
      (this.snapK = tb(t('graph.snapKeys'), t('tip.graph.snapKeys'), () => { this.snap.keys = !this.snap.keys; this.syncTools(); })),
      (this.snapV = tb(t('graph.snapValues'), t('tip.graph.snapValues'), () => { this.snap.values = !this.snap.values; this.syncTools(); })),
    );
    const handleGroup = h('div', { class: 'tb-group' },
      tb(t('graph.handle') + ' ▾', t('tip.graph.handle'), (e) => this.handleMenu(e.currentTarget)),
      tb(t('graph.flatten'), t('tip.graph.flatten'), () => ed.flattenTangents()),
      tb(t('graph.simplify'), t('tip.graph.simplify'), () => this.simplifyDialog()),
    );
    this.timeField = numInput(0, (v) => { if (!this.activePoint) return; ed.setPointTime(this.activePoint, ed.timeDisplay === 'frames' ? ed.timeOfFrame(Math.round(v)) : v); }, { step: 1, precision: 2 });
    this.timeField.title = t('tip.graph.time');
    this.valueField = numInput(0, (v) => { if (this.activePoint) ed.setPointValue(this.activePoint, v); }, { step: 0.1, precision: 3 });
    this.valueField.title = t('tip.graph.value');
    this.unitLabel = h('span', { class: 'tb-label unit', text: '' });
    const fieldGroup = h('div', { class: 'tb-group fields' }, h('span', { class: 'tb-label', text: t('graph.time') }), this.timeField, h('span', { class: 'tb-label', text: t('graph.value') }), this.valueField, this.unitLabel);
    this.tools.append(viewGroup, snapGroup, handleGroup, fieldGroup, h('span', { class: 'spacer' }), h('span', { class: 'graph-help', text: t('graph.help') }));
    this.syncTools();
    this.syncFields();
  }
  syncTools() {
    this.normBtn.classList.toggle('pressed', !!this.ui.normalize);
    this.snapF.classList.toggle('pressed', this.snap.frames);
    this.snapK.classList.toggle('pressed', this.snap.keys);
    this.snapV.classList.toggle('pressed', this.snap.values);
  }
  syncFields() {
    const ed = this.editor;
    if (this.drag?.mode === 'move') return; // refs are remapped as the drag goes; fields update on release
    const ref = this.activePoint && ed.keyOf(parsePointRef(this.activePoint).keyRef) ? this.activePoint : null;
    this.activePoint = ref;
    const dis = !ref;
    this.timeField.disabled = dis; this.valueField.disabled = dis;
    if (dis) { if (document.activeElement !== this.timeField) this.timeField.value = ''; if (document.activeElement !== this.valueField) this.valueField.value = ''; this.unitLabel.textContent = ''; return; }
    const { keyRef: kr, comp, ch } = parsePointRef(ref);
    const rec = ed.keyOf(kr);
    const es = ch === 'rot' ? trackEuler(rec.keys) : null;
    const v = ch === 'rot' ? es[rec.idx][comp] : rec.key.v[comp];
    if (document.activeElement !== this.timeField) this.timeField.value = ed.timeDisplay === 'frames' ? String(ed.frameOf(rec.key.t)) : fmt(rec.key.t, 2);
    this.timeField.step = ed.timeDisplay === 'frames' ? 1 : 0.01;
    if (document.activeElement !== this.valueField) this.valueField.value = fmt(v, 3);
    this.valueField.step = ch === 'rot' ? 1 : 0.01;
    this.unitLabel.textContent = ch === 'rot' ? '°' : 'm';
  }
  handleMenu(anchor) {
    const ed = this.editor;
    showMenu(anchor, [
      { head: t('graph.handleHead') },
      ...HANDLE_MODES.map((m) => ({ label: t('handle.' + m), tip: t('tip.handle.' + m), action: () => ed.setKeyHandles(m) })),
      { sep: true },
      { head: t('tl.interp') },
      ...INTERPOLATIONS.map((i) => ({ label: t('interp.' + i), tip: t('tip.interp.' + i), action: () => ed.setKeyInterpolation(i) })),
    ]);
  }

  // ---------- channel list ----------
  buildGroups() {
    const ed = this.editor;
    const c = activeClip(ed.project);
    if (!c) { this.groups = []; return; }
    const order = orderedNodes(ed.project).map((r) => r.node.id);
    this.groups = channelsOf(c, { order, nodeById: (id) => getNode(ed.project, id) });
    for (const g of this.groups) g.driven = g.node?.type === 'bone' ? ed.constraintDriving(g.nodeId) : null;
  }
  channelVisible(ch) {
    if (this.ui.solo) return ch.id === this.ui.solo;
    return !this.ui.hidden.has(ch.id) && !this.ui.hidden.has(ch.nodeId);
  }
  visibleChannels() {
    const f = (this.ui.filter || '').toLowerCase();
    const out = [];
    for (const g of this.groups) {
      const name = (g.node?.name || g.nodeId).toLowerCase();
      for (const ch of g.channels) {
        if (f && !name.includes(f) && !this.channelLabel(ch).toLowerCase().includes(f)) continue;
        if (this.channelVisible(ch)) out.push(ch);
      }
    }
    return out;
  }
  channelLabel(ch) { return `${t(ch.labelKey)} ${ch.axis}`; }
  colorOf(ch) { return (ch.ch === 'rot' ? ROT_COLORS : AXIS_COLORS)[ch.comp]; }
  // Rebuild the DOM list only when something it shows has changed (never while dragging).
  refreshList(force = false) {
    const ed = this.editor;
    if (!this.visible && !force) return;
    this.buildGroups();
    const key = [ed.project.activeClipId, this.groups.map((g) => g.nodeId + ':' + g.channels.length + ':' + (g.driven ? g.driven.id : '')).join(','), this.ui.filter, [...this.ui.hidden].join(','), this.ui.solo, [...this.ui.collapsed].join(','), this.ui.active, [...this.selChannels].join(','), [...ed.selection].join(',')].join('|');
    if (key === this._listKey && !force) return;
    this._listKey = key;
    this.search.placeholder = t('graph.search'); this.search.title = t('tip.graph.search');
    if (document.activeElement !== this.search && this.search.value !== (this.ui.filter || '')) this.search.value = this.ui.filter || '';
    const scrollTop = this.list.scrollTop;
    this.rows.innerHTML = '';
    const f = (this.ui.filter || '').toLowerCase();
    let any = false;
    for (const g of this.groups) {
      const name = g.node?.name || g.nodeId;
      const rows = g.channels.filter((ch) => !f || name.toLowerCase().includes(f) || this.channelLabel(ch).toLowerCase().includes(f));
      if (!rows.length) continue;
      any = true;
      const collapsed = this.ui.collapsed.has(g.nodeId);
      const groupHidden = this.ui.hidden.has(g.nodeId);
      const head = h('div', { class: 'gc-group' + (ed.selection.has(g.nodeId) ? ' selected' : ''), title: g.driven ? t('tip.graph.driven', { name: g.driven.name }) : name },
        h('span', { class: 'twisty', text: collapsed ? '▸' : '▾', onclick: (e) => { e.stopPropagation(); this.toggleSet('collapsed', g.nodeId); } }),
        h('span', { class: 'ico ' + (g.node?.type || ''), text: ICONS[g.node?.type] || '•' }),
        h('span', { class: 'name', text: name }),
        g.driven ? h('span', { class: 'chip warn', text: t('graph.driven'), title: t('tip.graph.driven', { name: g.driven.name }) }) : null,
        h('span', { class: 'vis' + (groupHidden ? ' off' : ''), text: groupHidden ? '◌' : '◉', title: t('tip.graph.visibility'), onclick: (e) => { e.stopPropagation(); this.toggleSet('hidden', g.nodeId); } }),
      );
      head.addEventListener('click', (e) => { ed.select(g.nodeId, e.shiftKey ? 'add' : 'replace'); this.selChannels = new Set(g.channels.map((c) => c.id)); this.refreshList(true); this.draw(); });
      head.addEventListener('dblclick', () => this.frameChannels(g.channels.map((c) => c.id)));
      this.rows.append(head);
      if (collapsed) continue;
      for (const ch of rows) {
        const hidden = !this.channelVisible(ch);
        const row = h('div', { class: 'gc-row' + (this.selChannels.has(ch.id) ? ' selected' : '') + (this.ui.active === ch.id ? ' active' : '') + (hidden ? ' off' : ''), dataset: { id: ch.id }, title: this.channelLabel(ch) + ' · ' + name },
          h('span', { class: 'swatch', style: `background:${this.colorOf(ch)}` }),
          h('span', { class: 'ax', text: ch.axis, style: `color:${AXIS_COLORS[ch.comp]}` }),
          h('span', { class: 'name', text: t(ch.labelKey) }),
          h('span', { class: 'solo' + (this.ui.solo === ch.id ? ' on' : ''), text: 'S', title: t('tip.graph.solo'), onclick: (e) => { e.stopPropagation(); ed.setGraphUI({ solo: this.ui.solo === ch.id ? null : ch.id }); } }),
          h('span', { class: 'vis' + (this.ui.hidden.has(ch.id) ? ' off' : ''), text: this.ui.hidden.has(ch.id) ? '◌' : '◉', title: t('tip.graph.visibility'), onclick: (e) => { e.stopPropagation(); this.toggleSet('hidden', ch.id); } }),
        );
        row.addEventListener('click', (e) => {
          if (e.ctrlKey || e.metaKey) { if (this.selChannels.has(ch.id)) this.selChannels.delete(ch.id); else this.selChannels.add(ch.id); }
          else if (e.shiftKey) this.selChannels.add(ch.id);
          else this.selChannels = new Set([ch.id]);
          ed.setGraphUI({ active: ch.id });
          if (this.ui.hidden.has(ch.id)) this.toggleSet('hidden', ch.id);
        });
        row.addEventListener('dblclick', () => this.frameChannels([ch.id]));
        this.rows.append(row);
      }
    }
    if (!any) this.rows.append(h('div', { class: 'empty', text: f ? t('graph.noMatch') : t('graph.noChannels') }));
    this.list.scrollTop = scrollTop;
    this.emptyEl.innerHTML = '';
    const c = activeClip(ed.project);
    if (!c) this.emptyEl.append(h('span', { text: ed.project.nodes.length ? t('tl.emptyNoClip') : t('tl.emptyNoScene') }));
    else if (!this.groups.length) this.emptyEl.append(h('span', { text: t('graph.noChannels') }));
  }
  toggleSet(which, id) { const s = new Set(this.ui[which]); if (s.has(id)) s.delete(id); else s.add(id); this.editor.setGraphUI({ [which]: s }); }

  // ---------- view ----------
  resize() {
    const plot = this.container.querySelector('#graph-plot');
    const w = plot.clientWidth, hh = plot.clientHeight;
    if (!w || !hh) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = w * dpr; this.canvas.height = hh * dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = hh + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.view.w = w - AXIS_W; this.view.h = hh - RULER_H; this.W = w; this.H = hh;
    this.maybeAutoFrame();
    this.draw();
  }
  saveView() { this.ui.view = { clipId: this.editor.project.activeClipId, t0: this.view.t0, pxPerSec: this.view.pxPerSec, vCenter: this.view.vCenter, pxPerUnit: this.view.pxPerUnit }; this.editor.scheduleSave(); }
  // When a different animation becomes active: restore the view the user last had for that
  // very clip (saved with the project), otherwise fit all of its curves. Never afterwards.
  maybeAutoFrame() {
    const c = activeClip(this.editor.project);
    const id = c ? c.id : null;
    if (id === this.framedClip || !this.W) return;
    this.framedClip = id;
    const saved = this.ui.view;
    if (saved && saved.clipId === id && Number.isFinite(saved.t0)) { const { clipId, ...v } = saved; Object.assign(this.view, v); return; }
    this.buildGroups();
    const r = this.rangeOf(this.visibleChannels());
    if (r) { Object.assign(this.view, fitView(this.view, r)); return; }
    const fit = fitTimeRange(keyRange(c), this.view.w, { defaultSpan: Math.max(1, c?.duration || 2) });
    this.view.t0 = fit.t0; this.view.pxPerSec = fit.pxPerSec; this.view.vCenter = 0; this.view.pxPerUnit = 60;
  }
  // value range of channels (normalized: [-1,1])
  rangeOf(chs, { selectedOnly = false } = {}) {
    const ed = this.editor, c = activeClip(ed.project);
    let t0 = Infinity, t1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const ch of chs) {
      const keys = c?.tracks[ch.nodeId]?.[ch.ch]; if (!keys?.length) continue;
      const es = ch.ch === 'rot' ? trackEuler(keys) : null;
      const n = this.norm(ch, keys, es);
      keys.forEach((k, i) => {
        if (selectedOnly && !ed.isPointSelected(keyRef(ch.nodeId, ch.ch, k.t), ch.comp)) return;
        const v = n.map(ch.ch === 'rot' ? es[i][ch.comp] : k.v[ch.comp]);
        t0 = Math.min(t0, k.t); t1 = Math.max(t1, k.t); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      });
    }
    if (!Number.isFinite(t0)) return null;
    if (v1 - v0 < 1e-6) { v0 -= 0.5; v1 += 0.5; }
    if (t1 - t0 < 1e-6) { t0 -= 0.25; t1 += 0.25; }
    return { t0, t1, v0, v1 };
  }
  // per-channel normalisation (Normalize mode maps each channel's key range onto [-1, 1])
  norm(ch, keys, es) {
    if (!this.ui.normalize) return { map: (v) => v, unmap: (v) => v, scale: 1 };
    let lo = Infinity, hi = -Infinity;
    keys.forEach((k, i) => { const v = ch.ch === 'rot' ? es[i][ch.comp] : k.v[ch.comp]; lo = Math.min(lo, v); hi = Math.max(hi, v); });
    const mid = (lo + hi) / 2, half = Math.max(1e-6, (hi - lo) / 2);
    return { map: (v) => (v - mid) / half, unmap: (v) => v * half + mid, scale: 1 / half };
  }
  applyRange(r) { if (!r) return; Object.assign(this.view, fitView(this.view, r)); this.saveView(); this.draw(); }
  frameAll() { this.buildGroups(); this.applyRange(this.rangeOf(this.visibleChannels())); }
  frameSelected() {
    this.buildGroups();
    const vis = this.visibleChannels();
    const r = this.editor.selectedKeys.size ? this.rangeOf(vis, { selectedOnly: true }) : this.rangeOf(vis.filter((c) => this.selChannels.has(c.id)));
    this.applyRange(r || this.rangeOf(vis));
  }
  frameChannels(ids) { this.buildGroups(); const chs = this.groups.flatMap((g) => g.channels).filter((c) => ids.includes(c.id)); this.applyRange(this.rangeOf(chs)); }
  frameClip() {
    const c = activeClip(this.editor.project); if (!c) return;
    const r = this.rangeOf(this.visibleChannels()) || { v0: -1, v1: 1 };
    this.applyRange({ t0: 0, t1: Math.max(0.5, clipEnd(c)), v0: r.v0, v1: r.v1 });
  }
  resetView() { this.view.t0 = -0.15; this.view.pxPerSec = 160; this.view.vCenter = 0; this.view.pxPerUnit = 60; this.saveView(); this.draw(); }

  // ---------- drawing ----------
  draw() {
    if (!this.visible || !this.W) return;
    this.maybeAutoFrame();
    const ed = this.editor, g = this.ctx, v = this.view;
    const c = activeClip(ed.project);
    g.clearRect(0, 0, this.W, this.H);
    g.fillStyle = '#1b1e24'; g.fillRect(0, 0, this.W, this.H);
    this.points = []; this.handles = []; this.curves = [];
    if (!c) return;
    const fps = ed.fps, frames = ed.timeDisplay === 'frames';
    const end = clipEnd(c);
    const x0 = AXIS_W, plotBottom = this.H;
    // outside-clip shading
    g.fillStyle = 'rgba(0,0,0,.28)';
    if (xOf(v, 0) > x0) g.fillRect(x0, RULER_H, xOf(v, 0) - x0, plotBottom - RULER_H);
    if (xOf(v, end) < this.W) g.fillRect(Math.max(x0, xOf(v, end)), RULER_H, this.W - xOf(v, end), plotBottom - RULER_H);
    // value grid + axis
    const norm = this.ui.normalize;
    const vStep = niceStep(v.pxPerUnit, 34);
    g.font = '10px system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'right';
    const vBottom = valueAt(v, plotBottom), vTop = valueAt(v, RULER_H);
    for (let val = Math.ceil(vBottom / vStep) * vStep; val <= vTop; val += vStep) {
      const y = Math.round(yOf(v, val)) + 0.5;
      g.strokeStyle = Math.abs(val) < 1e-9 ? '#3a4150' : '#262a32'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x0, y); g.lineTo(this.W, y); g.stroke();
      g.fillStyle = '#9aa3b0';
      g.fillText(norm ? fmt(val, 2) : this.axisLabel(val, vStep), x0 - 4, y);
    }
    // time grid + ruler
    const unit = frames ? 1 / fps : 1;
    let stepUnits = 1;
    while (stepUnits * unit * v.pxPerSec < 46) stepUnits *= stepUnits % 5 === 0 && stepUnits % 2 === 0 ? 2.5 : 2;
    stepUnits = Math.round(stepUnits);
    const step = stepUnits * unit;
    const tStart = Math.floor(v.t0 / step) * step;
    g.textAlign = 'left'; g.textBaseline = 'top';
    for (let tm = tStart; xOf(v, tm) < this.W; tm += step) {
      const x = xOf(v, tm); if (x < x0) continue;
      g.strokeStyle = Math.abs(tm) < 1e-9 ? '#3a4150' : '#262a32';
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, RULER_H); g.lineTo(Math.round(x) + 0.5, plotBottom); g.stroke();
    }
    g.fillStyle = '#14161a'; g.fillRect(0, 0, this.W, RULER_H);
    g.fillStyle = '#9aa3b0';
    for (let tm = tStart; xOf(v, tm) < this.W; tm += step) { const x = xOf(v, tm); if (x < x0) continue; g.fillText(frames ? String(Math.round(tm * fps)) : fmt(tm, 2) + 's', x + 3, 5); g.fillRect(Math.round(x), RULER_H - 6, 1, 6); }
    g.strokeStyle = '#6b7482'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(Math.round(xOf(v, end)) + 0.5, 0); g.lineTo(Math.round(xOf(v, end)) + 0.5, plotBottom); g.stroke();
    g.setLineDash([]);
    // curves
    const tA = timeAt(v, x0) - 0.5, tB = timeAt(v, this.W) + 0.5;
    const chs = this.visibleChannels();
    const active = this.ui.active;
    g.save(); g.beginPath(); g.rect(x0, RULER_H, this.W - x0, plotBottom - RULER_H); g.clip();
    const drawOrder = chs.slice().sort((a, b) => (a.id === active) - (b.id === active)); // active on top
    for (const ch of drawOrder) {
      const keys = c.tracks[ch.nodeId]?.[ch.ch]; if (!keys?.length) continue;
      const es = ch.ch === 'rot' ? trackEuler(keys) : null;
      const n = this.norm(ch, keys, es);
      const cacheKey = `${ch.id}|${ed.changeVersion}|${Math.round(v.pxPerSec)}|${norm}`;
      let samples = this.cache.get(cacheKey);
      if (!samples) { samples = sampleChannel(keys, ch.ch, ch.comp, es, tA, tB, v.pxPerSec); this.cache.set(cacheKey, samples); }
      const color = this.colorOf(ch);
      const isActive = ch.id === active, inSel = this.selChannels.has(ch.id);
      g.strokeStyle = color; g.globalAlpha = isActive || inSel || !this.selChannels.size ? 1 : 0.45;
      g.lineWidth = isActive ? 2 : 1.25;
      g.beginPath();
      const poly = [];
      samples.forEach((s, i) => { const x = xOf(v, s.t), y = yOf(v, n.map(s.v)); poly.push({ x, y }); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
      g.stroke();
      this.curves.push({ ch, poly });
      // points (visible only)
      keys.forEach((k, i) => {
        const x = xOf(v, k.t); if (x < x0 - 8 || x > this.W + 8) return;
        const val = ch.ch === 'rot' ? es[i][ch.comp] : k.v[ch.comp];
        const y = yOf(v, n.map(val));
        const kr = keyRef(ch.nodeId, ch.ch, k.t), ref = kr + '|' + ch.comp;
        const selected = ed.isPointSelected(kr, ch.comp);
        this.points.push({ x, y, ref, kr, comp: ch.comp, ch: ch.ch, nodeId: ch.nodeId, unit: ch.unit, t: k.t, v: val, idx: i, color, keys, chan: ch, n });
        this.dot(x, y, k.i, selected, this.activePoint === ref, color);
        if (selected && this.drag?.mode !== 'box') this.drawHandles(ch, keys, i, es, n, x, y, ref, color);
      });
      // current value marker on the curve at the playhead (evaluated pose incl. unkeyed edits)
      const px = xOf(v, ed.time);
      if (px >= x0) {
        const cur = ed.currentLocal(ch.nodeId);
        const cv = cur ? (ch.ch === 'rot' ? cur.rotE[ch.comp] : cur.pos[ch.comp]) : evaluateComponent(keys, ed.time, ch.ch, ch.comp, es);
        const y = yOf(v, n.map(cv));
        g.globalAlpha = 1; g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath(); g.arc(px, y, 3.5, 0, Math.PI * 2); g.stroke();
      }
      g.globalAlpha = 1;
    }
    g.restore();
    // axis column background + unit
    g.fillStyle = '#1b1e24'; g.fillRect(0, RULER_H, AXIS_W, plotBottom - RULER_H);
    g.fillStyle = '#14161a'; g.fillRect(0, 0, AXIS_W, RULER_H);
    g.strokeStyle = '#2a2e36'; g.beginPath(); g.moveTo(AXIS_W + 0.5, 0); g.lineTo(AXIS_W + 0.5, plotBottom); g.stroke();
    g.fillStyle = '#6b7482'; g.font = '10px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let val = Math.ceil(vBottom / vStep) * vStep; val <= vTop; val += vStep) g.fillText(norm ? fmt(val, 2) : this.axisLabel(val, vStep), AXIS_W - 4, yOf(v, val));
    g.textAlign = 'left'; g.fillText(norm ? t('graph.normalized') : this.unitText(), 4, 10);
    // box select
    if (this.drag?.mode === 'box') {
      const b = this.drag;
      g.strokeStyle = '#7ec8ff'; g.fillStyle = 'rgba(126,200,255,.12)';
      const rx = Math.min(b.x, b.cx), ry = Math.min(b.y, b.cy), rw = Math.abs(b.cx - b.x), rh = Math.abs(b.cy - b.y);
      g.fillRect(rx, ry, rw, rh); g.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    }
    // playhead
    const px = xOf(v, ed.time);
    if (px >= AXIS_W) {
      g.strokeStyle = '#2d6cdf'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, plotBottom); g.stroke();
      const label = frames ? String(ed.frameOf(ed.time)) : fmt(ed.time, 2);
      g.font = 'bold 10px system-ui, sans-serif'; g.textBaseline = 'middle';
      const tw = g.measureText(label).width + 8;
      g.fillStyle = '#2d6cdf'; g.fillRect(px - tw / 2, 3, tw, 15);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(label, px, 10.5); g.textAlign = 'left';
    }
  }
  unitText() {
    const a = this.groups?.flatMap((g) => g.channels).find((c) => c.id === this.ui.active);
    const vis = this.visibleChannels();
    const units = new Set((vis.length ? vis : []).map((c) => c.unit));
    const u = a?.unit || (units.size === 1 ? [...units][0] : null);
    return u === 'deg' ? '°' : u === 'm' ? 'm' : units.size > 1 ? 'm / °' : '';
  }
  axisLabel(val, step) { const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3; return val.toFixed(d); }
  dot(x, y, interp, selected, active, color) {
    const g = this.ctx;
    const r = active ? 5 : 4;
    g.beginPath();
    if (interp === 'step') g.rect(x - r, y - r, 2 * r, 2 * r); else g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = selected ? '#ffffff' : color; g.fill();
    g.strokeStyle = selected ? color : '#14161a'; g.lineWidth = selected ? 1.5 : 1; g.stroke();
    if (interp === 'linear' && !selected) { g.fillStyle = '#14161a'; g.beginPath(); g.arc(x, y, 1.4, 0, Math.PI * 2); g.fill(); }
  }
  drawHandles(ch, keys, i, es, n, x, y, ref, color) {
    const g = this.ctx, v = this.view, ed = this.editor;
    const k = keys[i];
    const sl = ed.pointSlopes(ref);
    if (!sl) return;
    for (const side of ['in', 'out']) {
      const nb = side === 'out' ? keys[i + 1] : keys[i - 1];
      if (!nb) continue;
      if ((side === 'out' && k.i !== 'ease') || (side === 'in' && keys[i - 1].i !== 'ease')) continue;
      const dt = (nb.t - k.t) / 3;
      const val = ch.ch === 'rot' ? es[i][ch.comp] : k.v[ch.comp];
      const hv = val + (side === 'out' ? sl.out : sl.in) * dt;
      const hx = xOf(v, k.t + dt), hy = yOf(v, n.map(hv));
      g.strokeStyle = '#c9ced6'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(hx, hy); g.stroke();
      g.fillStyle = '#c9ced6'; g.fillRect(hx - 3, hy - 3, 6, 6);
      g.strokeStyle = '#14161a'; g.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
      this.handles.push({ x: hx, y: hy, ref, side, kt: k.t, kv: val, n, unit: ch.unit, color });
    }
  }

  // ---------- interaction ----------
  bind() {
    const cv = this.canvas, ed = this.editor;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      this.onDown(e, pos(e));
      const d = this.drag;
      if (d && !d.owned) {
        d.owned = true; d.pointerId = e.pointerId;
        ed.beginInteraction('graph-' + d.mode, { finish: () => this.settle(d, false), cancel: () => this.settle(d, true), pointerId: e.pointerId });
      }
    });
    // one coalesced update per animation frame; the drag holds pointer capture, so crossing
    // frame lines, keys, curves or the canvas edge never ends it — only up/cancel/lost/Escape do
    cv.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) { this.onMove(e, pos(e)); return; }
      const r = d.rect || cv.getBoundingClientRect();
      this._pending = { e: { altKey: e.altKey, shiftKey: e.shiftKey }, x: e.clientX - r.left, y: e.clientY - r.top };
      if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; const m = this._pending; this._pending = null; if (m && this.drag === d) this.onMove(m.e, m); });
    });
    const up = () => { const d = this.drag; if (d) this.settle(d, false); };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up); cv.addEventListener('lostpointercapture', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x, y } = pos(e), v = this.view;
      const f = Math.exp(-e.deltaY * 0.0015);
      if (e.altKey) { v.t0 += e.deltaY / v.pxPerSec * 0.6; }
      else {
        const tAt = timeAt(v, x), vAt = valueAt(v, y);
        if (!e.shiftKey) { v.pxPerSec = Math.max(10, Math.min(5000, v.pxPerSec * f)); v.t0 = tAt - (x - AXIS_W) / v.pxPerSec; }
        if (!e.ctrlKey) { v.pxPerUnit = Math.max(1e-4, Math.min(1e6, v.pxPerUnit * f)); v.vCenter = vAt + (y - RULER_H - v.h / 2) / v.pxPerUnit; }
      }
      this.saveView(); this.draw();
    }, { passive: false });
    cv.addEventListener('dblclick', (e) => {
      const { x, y } = pos(e);
      if (y < RULER_H || x < AXIS_W || hitPoint(this.points, x, y)) return;
      const hit = this.curveAt(x, y);
      if (hit) { ed.setTime(this.snapTime(timeAt(this.view, x), e)); ed.insertKeyframe([hit.ch.nodeId], [hit.ch.ch]); }
    });
  }
  curveAt(x, y, tol = 6) {
    let best = null, bd = tol;
    for (const c of this.curves) for (let i = 1; i < c.poly.length; i++) {
      const a = c.poly[i - 1], b = c.poly[i];
      if (Math.max(a.x, b.x) < x - tol || Math.min(a.x, b.x) > x + tol) continue;
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const u = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
      const d = Math.hypot(x - (a.x + u * dx), y - (a.y + u * dy));
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  snapTime(tm, e) { return e?.altKey || !this.snap.frames ? snapTime(tm) : this.editor.timeOfFrame(Math.round(tm * this.editor.fps)); }
  snapValue(val, unit, e) {
    if (e?.altKey || !this.snap.values) return val;
    const s = unit === 'deg' ? (this.editor.snap.rot || 15) : (this.editor.snap.pos || 0.1);
    return Math.round(val / s) * s;
  }
  onDown(e, { x, y }) {
    const cv = this.canvas, ed = this.editor;
    cv.focus();
    const c = activeClip(ed.project);
    if (!c) return;
    try { cv.setPointerCapture(e.pointerId); } catch {}
    const rect = cv.getBoundingClientRect(); // cached for the whole drag: no layout reads per move
    if (e.button === 1 || (e.button === 0 && e.altKey)) { this.drag = { mode: 'pan', x, y, t0: this.view.t0, vc: this.view.vCenter, rect }; return; }
    if (e.button === 2) {
      const hit = hitPoint(this.points, x, y);
      if (hit && !ed.isPointSelected(hit.kr, hit.comp)) { ed.selectCurvePoints([hit.ref]); this.activePoint = hit.ref; }
      this.contextMenu(e, x, y);
      return;
    }
    if (e.button !== 0) return;
    if (y < RULER_H && x >= AXIS_W) { ed.pause(); ed.setTime(Math.max(0, this.snapTime(timeAt(this.view, x), e))); this.drag = { mode: 'scrub', rect }; return; }
    if (x < AXIS_W) return;
    // a key under the cursor wins over a handle: handles sit close to their own key at high zoom
    const hit = hitPoint(this.points, x, y);
    const hh = hit ? null : hitPoint(this.handles, x, y, 7);
    if (hh) { if (!ed.beginKeyDrag()) return; this.drag = { mode: 'handle', h: hh, free: e.altKey, moved: 0, rect }; return; }
    if (hit) {
      if (e.shiftKey) ed.selectCurvePoints([hit.ref], 'add');
      else if (e.ctrlKey || e.metaKey) ed.selectCurvePoints([hit.ref], 'toggle');
      else if (!ed.isPointSelected(hit.kr, hit.comp)) ed.selectCurvePoints([hit.ref]);
      this.activePoint = hit.ref; ed.setGraphUI({ active: hit.chan.id });
      this.syncFields();
      if (!ed.beginKeyDrag()) return;
      this.drag = { mode: 'move', x, y, startT: timeAt(this.view, x), startV: valueAt(this.view, y), unit: hit.unit, scale: hit.n.scale, lastDt: 0, lastDv: 0, moved: 0, axis: null, origActive: this.activePoint, rect };
    } else {
      this.drag = { mode: 'box', x, y, cx: x, cy: y, add: e.shiftKey, rect };
      if (!e.shiftKey) { ed.selectCurvePoints([]); this.activePoint = null; this.syncFields(); }
    }
  }
  onMove(e, { x, y }) {
    const ed = this.editor, d = this.drag, v = this.view;
    if (!d) {
      const hit = hitPoint(this.points, x, y) || hitPoint(this.handles, x, y, 7);
      this.canvas.style.cursor = hit ? 'pointer' : y < RULER_H && x > AXIS_W ? 'col-resize' : this.curveAt(x, y) ? 'crosshair' : 'default';
      return;
    }
    if (d.mode === 'pan') { v.t0 = d.t0 - (x - d.x) / v.pxPerSec; v.vCenter = d.vc + (y - d.y) / v.pxPerUnit; this.draw(); }
    else if (d.mode === 'scrub') ed.setTime(Math.max(0, this.snapTime(timeAt(v, x), e)));
    else if (d.mode === 'box') { d.cx = x; d.cy = y; this.draw(); }
    else if (d.mode === 'move') {
      let dt = timeAt(v, x) - d.startT, dv = (valueAt(v, y) - d.startV) / d.scale;
      // Shift: lock to the dominant axis (decided once the drag has a direction)
      if (e.shiftKey) { if (!d.axis && (Math.abs(x - d.x) > 4 || Math.abs(y - d.y) > 4)) d.axis = Math.abs(x - d.x) >= Math.abs(y - d.y) ? 't' : 'v'; if (d.axis === 't') dv = 0; else if (d.axis === 'v') dt = 0; }
      dt = this.snapDelta(dt, e);
      if (this.snap.values && !e.altKey) { const s = d.unit === 'deg' ? (ed.snap.rot || 15) : (ed.snap.pos || 0.1); dv = Math.round(dv / s) * s; }
      // total offset from the drag start, re-applied onto the pointer-down snapshot
      if (dt !== d.lastDt || dv !== d.lastDv) {
        ed.updateKeyDrag({ dt, dv, unit: d.unit });
        this.activePoint = d.origActive ? this.remapRef(d.origActive, dt) : null;
        d.lastDt = dt; d.lastDv = dv; d.moved++;
      }
    } else if (d.mode === 'handle') {
      const hd = d.h;
      let tH = timeAt(v, x), vH = hd.n.unmap(valueAt(v, y));
      const dtH = hd.side === 'out' ? Math.max(0.01, tH - hd.kt) : Math.min(-0.01, tH - hd.kt);
      const slope = (vH - hd.kv) / dtH;
      ed.setPointTangent(hd.ref, hd.side, slope, { free: d.free, commit: false });
      d.moved++;
    }
  }
  snapDelta(dt, e) {
    const ed = this.editor;
    let out = e?.altKey || !this.snap.frames ? snapTime(dt) : Math.round(dt * ed.fps) / ed.fps;
    if (this.snap.keys && !e?.altKey && this.activePoint) {
      const { t: t0 } = parsePointRef(this.activePoint);
      const c = activeClip(ed.project);
      const times = keyTimes(c).filter((tm) => !ed.selectedKeys.has(keyRef(parsePointRef(this.activePoint).nodeId, parsePointRef(this.activePoint).ch, tm)));
      const target = t0 + out;
      let best = null;
      for (const tm of times) if (Math.abs(tm - target) * this.view.pxPerSec <= 8 && (best === null || Math.abs(tm - target) < Math.abs(best - target))) best = tm;
      if (best !== null) out = snapTime(best - t0);
    }
    return out;
  }
  settle(d, cancel) {
    const ed = this.editor;
    if (this.drag === d) this.drag = null;
    try { if (d.pointerId != null && this.canvas.hasPointerCapture(d.pointerId)) this.canvas.releasePointerCapture(d.pointerId); } catch {}
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; if (this._pending && !cancel) this.onMove(this._pending.e, this._pending); this._pending = null; }
    if (d.mode === 'move') { ed.endKeyDrag(!cancel && d.moved > 0, t('hist.editCurve')); if (cancel) this.activePoint = d.origActive; }
    else if (d.mode === 'handle') ed.endKeyDrag(!cancel && d.moved > 0, t('hist.tangent'));
    else if (d.mode === 'box') {
      const inside = pointsInBox(this.points, d.x, d.y, d.cx, d.cy);
      ed.selectCurvePoints(inside.map((p) => p.ref), d.add ? 'add' : 'replace');
      if (inside.length) { this.activePoint = inside[0].ref; ed.setGraphUI({ active: inside[0].chan.id }); }
    }
    else if (d.mode === 'pan') this.saveView();
    ed.endInteraction('graph-' + d.mode);
    this.syncFields(); this.draw();
  }
  remapRef(ref, dt) { const p = parsePointRef(ref); return pointRef(p.nodeId, p.ch, snapTime(p.t + dt), p.comp); }
  selectAllVisible() {
    const ed = this.editor, c = activeClip(ed.project); if (!c) return;
    const refs = [];
    for (const ch of this.visibleChannels()) for (const k of c.tracks[ch.nodeId]?.[ch.ch] || []) refs.push(pointRef(ch.nodeId, ch.ch, k.t, ch.comp));
    ed.selectCurvePoints(refs);
  }
  contextMenu(e, x, y) {
    const ed = this.editor;
    const curve = this.curveAt(x, y);
    const activeCh = this.groups?.flatMap((g) => g.channels).find((c) => c.id === this.ui.active);
    const target = curve?.ch || activeCh;
    const has = ed.selectedKeys.size > 0;
    const menu = showMenu({ x: e.clientX, y: e.clientY }, [
      { label: t('graph.insertKey'), icon: '◆', disabled: !target, action: () => { ed.setTime(this.snapTime(timeAt(this.view, x), e)); ed.insertKeyframe([target.nodeId], [target.ch]); } },
      { label: t('menu.deleteKeys'), disabled: !has, action: () => ed.deleteSelectedKeys() },
      { label: t('menu.duplicateKeys'), disabled: !has, action: () => ed.duplicateSelectedKeys() },
      { label: t('menu.copyKeys'), disabled: !has, action: () => ed.copySelectedKeys() },
      { label: t('menu.pasteKeys'), disabled: !ed.keyClipboard, action: () => ed.pasteKeys() },
      { sep: true },
      { head: t('tl.interp') },
      ...INTERPOLATIONS.map((i) => ({ label: t('interp.' + i), tip: t('tip.interp.' + i), disabled: !has, action: () => ed.setKeyInterpolation(i) })),
      { head: t('graph.handleHead') },
      ...HANDLE_MODES.map((m) => ({ label: t('handle.' + m), tip: t('tip.handle.' + m), disabled: !has, action: () => ed.setKeyHandles(m) })),
      { label: t('graph.flatten'), disabled: !has, action: () => ed.flattenTangents() },
      { sep: true },
      { label: t('graph.frameSel'), action: () => this.frameSelected() },
    ]);
    return menu;
  }
  // Simplify curves: tolerance dialog with a live before → after count
  simplifyDialog() {
    const ed = this.editor;
    if (!activeClip(ed.project)) return;
    let tolPos = 0.005, tolRot = 0.5, scoped = ed.selection.size > 0;
    const scope = () => (scoped ? [...ed.selection] : null);
    const preview = h('div', { class: 'hint', text: '' });
    const update = () => { const r = ed.simplifyCurves({ nodeIds: scope(), tolPos, tolRot }, { dryRun: true }); preview.textContent = t('graph.simplifyPreview', { before: r.before, after: r.after }); };
    const body = () => { update(); return h('div', { class: 'simplify' },
      h('div', { class: 'hint', text: t('graph.simplifyIntro') }),
      h('div', { class: 'row' }, h('span', { text: t('graph.tolPos') }), numInput(tolPos, (v) => { tolPos = Math.max(0, v); update(); }, { step: 0.001, min: 0, precision: 3 })),
      h('div', { class: 'row' }, h('span', { text: t('graph.tolRot') }), numInput(tolRot, (v) => { tolRot = Math.max(0, v); update(); }, { step: 0.1, min: 0, precision: 2 })),
      ed.selection.size ? checkbox(t('graph.simplifyScope'), scoped, (v) => { scoped = v; update(); }) : null,
      preview); };
    customDialog({ title: () => t('graph.simplifyTitle'), body, buttons: [{ label: () => t('btn.cancel'), value: () => null }, { label: () => t('graph.apply'), primary: true, value: () => 'ok' }] })
      .then((r) => { if (r === 'ok') ed.simplifyCurves({ nodeIds: scope(), tolPos, tolRot }); });
  }
}
