// Timeline / dope sheet: transport controls, clip switcher, Auto Key, and a
// canvas showing keyframes per node with scrubbing, box selection, drag to
// move, zoom and pan.
import { t, onLangChange } from '../i18n/i18n.js';
import { h, selectInput, numInput, fmt } from './dom.js';
import { showMenu } from './dialogs.js';
import { activeClip, clipEnd, keyRef, allKeys, INTERPOLATIONS, snapTime } from '../anim/clips.js';
import { orderedNodes, getNode } from '../scene/scene.js';
import { primaryKeyLabel } from './shortcuts.js';
import { GraphEditor } from './graph-editor.js';
import { keyRange, fitTimeRange, ZOOM_MIN, ZOOM_MAX } from './timeline-fit.js';
import { loadPrefs, updatePrefs } from '../core/persistence.js';

const LABEL_W = 150, RULER_H = 22, ROW_H = 20;
const KEY_COLORS = { pos: '#f5a623', rot: '#7ec8ff', both: '#e4e8ef' };

export class Timeline {
  constructor(editor, container) {
    this.editor = editor;
    this.container = container;
    this.head = container.querySelector('#tl-head');
    this.canvas = container.querySelector('#tl-canvas');
    this.emptyEl = container.querySelector('#tl-empty');
    this.ctx = this.canvas.getContext('2d');
    this.t0 = -0.15; // time at the left edge of the key area
    this.pxPerSec = 160;
    this.scrollY = 0;
    // Auto-framing: the view is fitted to the keyed range whenever a different animation
    // becomes active (switch, new, duplicate, import, project open/recover). Pan and zoom are
    // otherwise the user's: editing keys, scrubbing, playing or selecting never touch them.
    this.framedClip = undefined;   // clip id the current view was framed for
    this.frameWhenSized = false;   // framing requested while the canvas had no size yet
    this.rows = [];
    this.drag = null;
    this.hover = null;
    this.graph = new GraphEditor(editor, container.querySelector('#graph-body'));
    this.mode = loadPrefs().animEditor === 'graph' ? 'graph' : 'dope';
    this.buildHead();
    this.bind();
    this.bindMove();
    this.applyMode();
    new ResizeObserver(() => this.resize()).observe(container.querySelector('#tl-body'));
    editor.on('change', (d) => { if (!d?.transient) this.syncHead(); this.draw(); });
    editor.on('time', () => { this.syncHead(); this.draw(); });
    editor.on('project', () => { this.framedClip = undefined; }); // a new/opened project frames again even if the clip id repeats
    editor.on('keys', () => this.draw());
    editor.on('selection', () => this.draw());
    editor.on('play', () => this.syncHead());
    onLangChange(() => { this.buildHead(); this.draw(); });
    this.resize();
  }

  // ---------- header ----------
  buildHead() {
    const ed = this.editor;
    this.head.innerHTML = '';
    const tb = (label, tip, onClick, cls = '') => { const b = h('button', { class: 'tb-btn ' + cls, text: label, title: tip, onclick: onClick }); return b; };
    const modes = h('div', { class: 'tb-group mode-switch' },
      (this.dopeBtn = tb(t('graph.mode.dope'), t('tip.graph.dope'), () => this.setMode('dope'))),
      (this.graphBtn = tb(t('graph.mode.graph'), t('tip.graph.graph'), () => this.setMode('graph'))),
    );
    const transport = h('div', { class: 'tb-group' },
      tb('⏮', t('tip.tl.start', { k: primaryKeyLabel('anim.jumpStart') }), () => { ed.pause(); ed.setTime(0); }),
      tb('◀', t('tip.tl.stepBack', { k: primaryKeyLabel('anim.stepBack') }), () => ed.stepFrames(-1)),
      (this.playBtn = tb('▶', t('tip.tl.play', { k: primaryKeyLabel('anim.play') }), () => ed.togglePlay())),
      tb('▶', t('tip.tl.stepForward', { k: primaryKeyLabel('anim.stepForward') }), () => ed.stepFrames(1)),
      tb('⏭', t('tip.tl.end', { k: primaryKeyLabel('anim.jumpEnd') }), () => { ed.pause(); const c = activeClip(ed.project); if (c) ed.setTime(clipEnd(c)); }),
      (this.loopBtn = tb('🔁', t('tip.tl.loop'), () => { const c = activeClip(ed.project); if (c) ed.setClipProps(c.id, { loop: !c.loop }); }, 'tb-toggle')),
    );
    this.clipSelect = selectInput([], '', (v) => ed.setActiveClip(v));
    this.clipSelect.title = t('tip.tl.clip');
    const clipGroup = h('div', { class: 'tb-group' }, h('span', { class: 'tb-label', style: 'font-size:11px;color:#9aa3b0;padding:0 4px', text: t('tl.clip') }), this.clipSelect,
      tb('+', t('tip.clip.new'), () => ed.createClip()));
    this.timeInput = numInput(0, (v) => { ed.pause(); ed.setTime(ed.timeDisplay === 'frames' ? ed.timeOfFrame(Math.round(v)) : v); }, { step: 1, precision: 2 });
    this.timeInput.title = t('tip.tl.current');
    this.timeModeBtn = tb('F', t('tip.tl.timeMode'), () => ed.setTimeDisplay(ed.timeDisplay === 'frames' ? 'seconds' : 'frames'));
    this.durInput = numInput(2, (v) => { const c = activeClip(ed.project); if (c) ed.setClipProps(c.id, { duration: Math.max(0.03, ed.timeDisplay === 'frames' ? ed.timeOfFrame(Math.round(v)) : v) }); }, { step: 1, precision: 2 });
    this.durInput.title = t('tip.tl.duration');
    this.fpsSelect = selectInput([24, 30, 60].map((f) => ({ value: f, label: f + ' fps' })), ed.fps, (v) => ed.setSetting('fps', parseInt(v, 10)));
    this.fpsSelect.title = t('tip.props.fps');
    const timeGroup = h('div', { class: 'tb-group' }, this.timeModeBtn, this.timeInput, h('span', { style: 'color:#6b7482;font-size:11px', text: '/' }), this.durInput, this.fpsSelect);
    this.autoKeyBtn = tb(t('tl.autoKey'), t('tip.tl.autoKey', { k: primaryKeyLabel('anim.autoKey') }), () => ed.toggleAutoKey(), 'autokey');
    this.interpSelect = selectInput([{ value: '', label: t('tl.interp') }, ...INTERPOLATIONS.map((i) => ({ value: i, label: t('interp.' + i) }))], '', (v) => { if (v) { ed.setKeyInterpolation(v); this.interpSelect.value = ''; } });
    this.interpSelect.title = t('tip.tl.interp');
    const keyGroup = h('div', { class: 'tb-group' }, this.autoKeyBtn,
      tb(t('tl.insertKey'), t('tip.tl.insertKey', { k: primaryKeyLabel('anim.insertKey') }), () => ed.insertKeyframe()),
      this.interpSelect,
      tb('✕', t('tip.tl.deleteKeys'), () => ed.deleteSelectedKeys()));
    const viewGroup = h('div', { class: 'tb-group' },
      tb('⤢', t('tip.tl.frame', { k: primaryKeyLabel('view.frameAll') }), () => this.frameAnimation()),
      (this.collapseBtn = tb('▾', t('tip.tl.collapse'), () => { this.container.classList.toggle('collapsed'); this.collapseBtn.textContent = this.container.classList.contains('collapsed') ? '▴' : '▾'; this.resize(); })));
    this.head.append(modes, transport, clipGroup, timeGroup, keyGroup, h('span', { class: 'spacer' }), viewGroup);
    this.syncHead();
  }
  syncHead() {
    const ed = this.editor;
    const c = activeClip(ed.project);
    this.dopeBtn.classList.toggle('active', this.mode === 'dope');
    this.graphBtn.classList.toggle('active', this.mode === 'graph');
    this.playBtn.textContent = ed.playing ? '❚❚' : '▶';
    this.playBtn.classList.toggle('active', ed.playing);
    this.loopBtn.classList.toggle('pressed', !!c?.loop);
    const opts = ed.project.clips.map((x) => ({ value: x.id, label: x.name }));
    const cur = this.clipSelect.value;
    this.clipSelect.innerHTML = '';
    if (!opts.length) this.clipSelect.append(h('option', { value: '', text: t('tl.noClip') }));
    for (const o of opts) this.clipSelect.append(h('option', { value: o.value, text: o.label, selected: o.value === ed.project.activeClipId }));
    this.clipSelect.disabled = !opts.length;
    const frames = ed.timeDisplay === 'frames';
    this.timeModeBtn.textContent = frames ? t('tl.frames') : t('tl.seconds');
    if (document.activeElement !== this.timeInput) this.timeInput.value = frames ? String(ed.frameOf(ed.time)) : fmt(ed.time, 2);
    this.timeInput.step = frames ? 1 : 0.01;
    if (document.activeElement !== this.durInput) this.durInput.value = c ? (frames ? String(ed.frameOf(c.duration)) : fmt(c.duration, 2)) : '';
    this.durInput.disabled = !c;
    this.autoKeyBtn.classList.toggle('on', !!ed.project.settings.autoKey);
    this.autoKeyBtn.textContent = t('tl.autoKey');
    this.fpsSelect.value = String(ed.fps);
    for (const b of this.head.querySelectorAll('button')) if (b !== this.collapseBtn && b !== this.dopeBtn && b !== this.graphBtn && b.textContent !== '+' && !b.classList.contains('autokey')) b.disabled = !c && b.parentElement !== this.head.lastChild;
    this.emptyEl.innerHTML = '';
    if (!c) {
      this.emptyEl.append(h('span', { text: ed.project.nodes.length ? t('tl.emptyNoClip') : t('tl.emptyNoScene') }));
      if (ed.project.nodes.length) this.emptyEl.append(h('button', { class: 'mini', text: t('clip.new'), onclick: () => ed.createClip() }));
    } else if (!Object.keys(c.tracks).length) this.emptyEl.append(h('span', { text: t('tl.emptyNoKeys', { k: primaryKeyLabel('anim.insertKey') }) }));
  }

  // ---------- Dope Sheet / Graph Editor ----------
  // Both views share this header, the active clip, the playhead and the key selection; the
  // Graph Editor simply takes over the body area. The choice is a preference of this editor.
  setMode(m) {
    if (m === this.mode) return;
    this.editor.finishInteraction(); // a drag never survives a view switch
    this.mode = m;
    updatePrefs({ animEditor: m });
    this.applyMode();
    this.syncHead();
    this.editor.emit('animEditor', m);
  }
  applyMode() {
    const graph = this.mode === 'graph';
    this.container.querySelector('#tl-body').hidden = graph;
    this.container.querySelector('#graph-body').hidden = !graph;
    this.container.classList.toggle('graph-mode', graph);
    // curves need height: a collapsed or default-sized timeline grows for the session (the
    // resize handle still sets the persisted height)
    if (graph && this.container.offsetHeight < 300 && !this._grew) { this.container.classList.remove('collapsed'); this.container.style.height = '340px'; this._grew = true; }
    if (graph) { this.graph.refreshList(true); this.graph.resize(); this.graph.draw(); }
    else this.resize();
  }
  // keyboard shortcuts treat both canvases as "the timeline"
  isFocused() { const a = document.activeElement; return a === this.canvas || a === this.graph.canvas; }
  frameAll() { if (this.mode === 'graph') this.graph.frameClip(); else { this.frameAnimation(); this.draw(); } }
  frameSelected() { if (this.mode === 'graph') this.graph.frameSelected(); else this.frameSelectedKeys(); }
  frameSelectedKeys() {
    const ed = this.editor;
    const times = [...ed.selectedKeys].map((r) => Number(r.split('|')[2])).filter(Number.isFinite);
    if (!times.length) { this.frameAll(); return; }
    const fit = fitTimeRange({ t0: Math.min(...times), t1: Math.max(...times) }, this.w - LABEL_W);
    this.t0 = fit.t0; this.pxPerSec = fit.pxPerSec; this.draw();
  }
  selectAllKeys() { if (this.mode === 'graph') this.graph.selectAllVisible(); else { const c = activeClip(this.editor.project); if (c) this.editor.selectKeys(allKeys(c).map((k) => keyRef(k.nodeId, k.channel, k.t))); } }

  // ---------- geometry ----------
  resize() {
    const body = this.container.querySelector('#tl-body');
    const w = body.clientWidth, hh = body.clientHeight;
    if (!w || !hh) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = w * dpr; this.canvas.height = hh * dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = hh + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = hh;
    if (this.frameWhenSized) this.frameAnimation();
    this.draw();
  }
  // Fit every keyframe of the active animation (all channels) into the key area, centred with
  // padding. Same calculation as the automatic framing; also the ⤢ button / F in the timeline.
  frameAnimation() {
    const c = activeClip(this.editor.project);
    const width = (this.w || 0) - LABEL_W;
    if (width < 40) { this.frameWhenSized = true; return; }   // hidden (Model workspace, collapsed): frame once it has a size
    const fit = fitTimeRange(keyRange(c), width, { defaultSpan: Math.max(1, c?.duration || 2) });
    this.t0 = fit.t0; this.pxPerSec = fit.pxPerSec; this.scrollY = 0;
    this.framedClip = c ? c.id : null;
    this.frameWhenSized = false;
  }
  maybeAutoFrame() {
    const c = activeClip(this.editor.project);
    const id = c ? c.id : null;
    if (id === this.framedClip) return;
    this.frameAnimation();
  }
  xOf(time) { return LABEL_W + (time - this.t0) * this.pxPerSec; }
  timeAt(x) { return this.t0 + (x - LABEL_W) / this.pxPerSec; }
  rowAt(y) { const i = Math.floor((y - RULER_H + this.scrollY) / ROW_H); return i >= 0 && i < this.rows.length ? i : -1; }
  yOfRow(i) { return RULER_H + i * ROW_H - this.scrollY; }
  fit() { this.frameAnimation(); this.draw(); }
  buildRows() {
    const ed = this.editor;
    const c = activeClip(ed.project);
    this.rows = [];
    if (!c) return;
    this.rows.push({ kind: 'summary', label: t('tl.summary') });
    for (const { node, depth } of orderedNodes(ed.project)) {
      const tr = c.tracks[node.id];
      if (!tr || (!tr.pos.length && !tr.rot.length)) continue;
      this.rows.push({ kind: 'node', node, depth, tr });
    }
  }

  draw() {
    if (!this.w || this.mode === 'graph') return;
    this.maybeAutoFrame();
    const ed = this.editor, g = this.ctx;
    const c = activeClip(ed.project);
    this.buildRows();
    g.clearRect(0, 0, this.w, this.h);
    g.fillStyle = '#1b1e24'; g.fillRect(0, 0, this.w, this.h);
    if (!c) return;
    const fps = ed.fps;
    const end = clipEnd(c);
    const x0 = LABEL_W, xEnd = this.xOf(end);
    // rows background
    for (let i = 0; i < this.rows.length; i++) {
      const y = this.yOfRow(i);
      if (y + ROW_H < RULER_H || y > this.h) continue;
      g.fillStyle = i % 2 ? '#1f2329' : '#20242c';
      if (this.rows[i].kind === 'summary') g.fillStyle = '#262b34';
      g.fillRect(0, y, this.w, ROW_H);
    }
    // outside clip shading
    g.fillStyle = 'rgba(0,0,0,.28)';
    if (x0 < this.xOf(0)) g.fillRect(x0, RULER_H, Math.max(0, this.xOf(0) - x0), this.h - RULER_H);
    if (xEnd < this.w) g.fillRect(Math.max(x0, xEnd), RULER_H, this.w - xEnd, this.h - RULER_H);
    // grid + ruler
    const frames = ed.timeDisplay === 'frames';
    const unit = frames ? 1 / fps : 1;
    let stepUnits = 1;
    while (stepUnits * unit * this.pxPerSec < 46) stepUnits *= stepUnits % 5 === 0 && stepUnits % 2 === 0 ? 2.5 : 2;
    stepUnits = Math.round(stepUnits);
    const step = stepUnits * unit;
    g.font = '10px system-ui, sans-serif'; g.textBaseline = 'top';
    const tStart = Math.floor(Math.max(this.t0, -1e9) / step) * step;
    for (let tm = tStart; this.xOf(tm) < this.w; tm += step) {
      const x = this.xOf(tm);
      if (x < x0) continue;
      const major = true;
      g.strokeStyle = tm === 0 ? '#3a4150' : '#2a2e36'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, RULER_H); g.lineTo(Math.round(x) + 0.5, this.h); g.stroke();
      g.fillStyle = '#9aa3b0';
      g.fillText(frames ? String(Math.round(tm * fps)) : fmt(tm, 2) + 's', x + 3, 4);
    }
    // ruler background line
    g.fillStyle = '#14161a'; g.fillRect(0, 0, this.w, RULER_H);
    g.fillStyle = '#9aa3b0';
    for (let tm = tStart; this.xOf(tm) < this.w; tm += step) { const x = this.xOf(tm); if (x < x0) continue; g.fillText(frames ? String(Math.round(tm * fps)) : fmt(tm, 2) + 's', x + 3, 5); g.fillRect(Math.round(x), RULER_H - 6, 1, 6); }
    // clip end marker
    g.strokeStyle = '#6b7482'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(Math.round(xEnd) + 0.5, 0); g.lineTo(Math.round(xEnd) + 0.5, this.h); g.stroke();
    g.setLineDash([]);
    // keys
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const y = this.yOfRow(i) + ROW_H / 2;
      if (y < RULER_H - ROW_H || y > this.h + ROW_H) continue;
      if (r.kind === 'summary') {
        const times = new Set();
        for (const k of allKeys(c)) times.add(k.t);
        for (const tm of times) this.diamond(this.xOf(tm), y, 5, '#c9ced6', false, allKeys(c).some((k) => k.t === tm && ed.selectedKeys.has(keyRef(k.nodeId, k.channel, k.t))));
      } else {
        const posT = new Set(r.tr.pos.map((k) => k.t));
        for (const k of r.tr.pos) this.diamond(this.xOf(k.t), y, 5.5, KEY_COLORS.pos, k.i, ed.selectedKeys.has(keyRef(r.node.id, 'pos', k.t)), r.tr.rot.some((rk) => rk.t === k.t) ? 'left' : null);
        for (const k of r.tr.rot) this.diamond(this.xOf(k.t), y, 5.5, KEY_COLORS.rot, k.i, ed.selectedKeys.has(keyRef(r.node.id, 'rot', k.t)), posT.has(k.t) ? 'right' : null);
      }
    }
    // labels column
    g.fillStyle = '#1b1e24'; g.fillRect(0, RULER_H, LABEL_W, this.h - RULER_H);
    g.fillStyle = '#14161a'; g.fillRect(0, 0, LABEL_W, RULER_H);
    g.strokeStyle = '#2a2e36'; g.beginPath(); g.moveTo(LABEL_W + 0.5, 0); g.lineTo(LABEL_W + 0.5, this.h); g.stroke();
    g.font = '12px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const y = this.yOfRow(i) + ROW_H / 2;
      if (y < RULER_H || y > this.h) continue;
      const selected = r.kind === 'node' && ed.selection.has(r.node.id);
      if (selected) { g.fillStyle = 'rgba(45,108,223,.25)'; g.fillRect(0, y - ROW_H / 2, LABEL_W, ROW_H); }
      g.fillStyle = r.kind === 'summary' ? '#d8dbe0' : selected ? '#fff' : '#9aa3b0';
      const label = r.kind === 'summary' ? r.label : r.node.name;
      const maxW = LABEL_W - 14 - (r.depth || 0) * 8;
      g.fillText(ellipsize(g, label, maxW), 8 + (r.depth || 0) * 8, y);
    }
    // box select
    if (this.drag?.mode === 'box') {
      const b = this.drag;
      g.strokeStyle = '#7ec8ff'; g.fillStyle = 'rgba(126,200,255,.12)';
      const rx = Math.min(b.x, b.cx), ry = Math.min(b.y, b.cy), rw = Math.abs(b.cx - b.x), rh = Math.abs(b.cy - b.y);
      g.fillRect(rx, ry, rw, rh); g.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    }
    // playhead
    const px = this.xOf(ed.time);
    if (px >= LABEL_W) {
      g.strokeStyle = '#2d6cdf'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, this.h); g.stroke();
      const label = frames ? String(ed.frameOf(ed.time)) : fmt(ed.time, 2);
      g.font = 'bold 10px system-ui, sans-serif'; g.textBaseline = 'middle';
      const tw = g.measureText(label).width + 8;
      g.fillStyle = '#2d6cdf'; g.fillRect(px - tw / 2, 3, tw, 15);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(label, px, 10.5); g.textAlign = 'left';
    }
  }
  diamond(x, y, r, color, interp, selected, half = null) {
    const g = this.ctx;
    g.beginPath();
    if (half === 'left') { g.moveTo(x, y - r); g.lineTo(x - r, y); g.lineTo(x, y + r); g.closePath(); }
    else if (half === 'right') { g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.closePath(); }
    else { g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); }
    g.fillStyle = selected ? '#ffffff' : color;
    g.fill();
    g.strokeStyle = selected ? color : '#14161a'; g.lineWidth = selected ? 1.5 : 1; g.stroke();
    if (interp === 'step') { g.fillStyle = '#14161a'; g.fillRect(x - 1.5, y - 1.5, 3, 3); }
    else if (interp === 'ease') { g.strokeStyle = '#14161a'; g.beginPath(); g.arc(x, y, 1.8, 0, Math.PI * 2); g.stroke(); }
  }

  // ---------- interaction ----------
  keyAt(x, y) {
    const i = this.rowAt(y);
    if (i < 0) return null;
    const r = this.rows[i];
    const c = activeClip(this.editor.project);
    if (!c) return null;
    const tm = this.timeAt(x);
    const tol = 7 / this.pxPerSec;
    if (r.kind === 'summary') {
      const hits = allKeys(c).filter((k) => Math.abs(k.t - tm) <= tol);
      if (!hits.length) return null;
      const best = hits.reduce((a, b) => (Math.abs(a.t - tm) < Math.abs(b.t - tm) ? a : b));
      return { refs: allKeys(c).filter((k) => k.t === best.t).map((k) => keyRef(k.nodeId, k.channel, k.t)), t: best.t };
    }
    const cands = [...r.tr.pos.map((k) => ({ ch: 'pos', k })), ...r.tr.rot.map((k) => ({ ch: 'rot', k }))].filter((e) => Math.abs(e.k.t - tm) <= tol);
    if (!cands.length) return null;
    const best = cands.reduce((a, b) => (Math.abs(a.k.t - tm) < Math.abs(b.k.t - tm) ? a : b));
    const same = cands.filter((e) => e.k.t === best.k.t);
    return { refs: same.map((e) => keyRef(r.node.id, e.ch, e.k.t)), t: best.k.t };
  }
  bind() {
    const cv = this.canvas, ed = this.editor;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      this.onDown(e);
      // the drag (if any) owns the pointer from here; finishing/cancelling it from
      // elsewhere (Escape, blur, another interaction) goes through these callbacks
      const d = this.drag;
      if (d && !d.owned) {
        d.owned = true; d.pointerId = e.pointerId;
        ed.beginInteraction('timeline-' + d.mode, { finish: () => this.settle(d, false), cancel: () => this.settle(d, true), pointerId: e.pointerId });
      }
    });
  }
  onDown(e) {
    const cv = this.canvas, ed = this.editor;
    const pos = (ev) => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    {
      cv.focus();
      const { x, y } = pos(e);
      const c = activeClip(ed.project);
      if (!c) return;
      try { cv.setPointerCapture(e.pointerId); } catch {}
      if (e.button === 1 || (e.button === 0 && e.altKey)) { this.drag = { mode: 'pan', x, y, t0: this.t0, sy: this.scrollY, rect: cv.getBoundingClientRect() }; return; }
      if (e.button === 2) {
        const hit = this.keyAt(x, y);
        if (hit) { if (!hit.refs.some((r) => ed.selectedKeys.has(r))) ed.selectKeys(hit.refs); this.keyMenu(e); }
        return;
      }
      if (e.button !== 0) return;
      if (y < RULER_H || x < LABEL_W) {
        if (y < RULER_H && x >= LABEL_W) { ed.pause(); ed.setTime(this.snap(this.timeAt(x), e)); this.drag = { mode: 'scrub', rect: cv.getBoundingClientRect() }; }
        else if (x < LABEL_W) { const i = this.rowAt(y); const r = this.rows[i]; if (r?.kind === 'node') ed.select(r.node.id, e.shiftKey ? 'add' : 'replace'); else if (r?.kind === 'summary') ed.selectKeys(allKeys(c).map((k) => keyRef(k.nodeId, k.channel, k.t))); }
        return;
      }
      const hit = this.keyAt(x, y);
      if (hit) {
        if (e.shiftKey) ed.selectKeys(hit.refs, 'add');
        else if (e.ctrlKey || e.metaKey) ed.selectKeys(hit.refs, 'toggle');
        else if (!hit.refs.every((r) => ed.selectedKeys.has(r))) ed.selectKeys(hit.refs);
        if (!ed.beginKeyDrag()) return;
        this.drag = { mode: 'move', x, startT: this.timeAt(x), moved: 0, lastDt: 0, rect: cv.getBoundingClientRect() };
      } else {
        this.drag = { mode: 'box', x, y, cx: x, cy: y, add: e.shiftKey, rect: cv.getBoundingClientRect() };
        if (!e.shiftKey) ed.selectKeys([]);
      }
    }
  }
  // Ends drag `d` (normal pointerup, or finish/cancel from the interaction state machine).
  settle(d, cancel) {
    const ed = this.editor;
    if (this.drag === d) this.drag = null;
    try { if (d.pointerId != null && this.canvas.hasPointerCapture(d.pointerId)) this.canvas.releasePointerCapture(d.pointerId); } catch {}
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; if (this._pending && !cancel) this.applyMove(d, this._pending); this._pending = null; }
    if (d.mode === 'move') ed.endKeyDrag(!cancel && d.moved > 0, t('hist.moveKeys'));
    else if (d.mode === 'box') {
      const c = activeClip(ed.project);
      if (c) {
        const rx0 = Math.min(d.x, d.cx), rx1 = Math.max(d.x, d.cx), ry0 = Math.min(d.y, d.cy), ry1 = Math.max(d.y, d.cy);
        const refs = [];
        for (let i = 0; i < this.rows.length; i++) {
          const y = this.yOfRow(i) + ROW_H / 2;
          if (y < ry0 || y > ry1) continue;
          const r = this.rows[i];
          if (r.kind === 'summary') { for (const k of allKeys(c)) { const x = this.xOf(k.t); if (x >= rx0 && x <= rx1) refs.push(keyRef(k.nodeId, k.channel, k.t)); } }
          else for (const ch of ['pos', 'rot']) for (const k of r.tr[ch]) { const x = this.xOf(k.t); if (x >= rx0 && x <= rx1) refs.push(keyRef(r.node.id, ch, k.t)); }
        }
        ed.selectKeys(refs, d.add ? 'add' : 'replace');
      }
    }
    ed.endInteraction('timeline-' + d.mode);
    this.draw();
  }
  bindMove() {
    const cv = this.canvas, ed = this.editor;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    // Pointer moves are coalesced to one update per animation frame; the drag owns the pointer
    // (capture) so crossing frame lines, keys or rows — or leaving the canvas — never ends it.
    cv.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) { const { x, y } = pos(e); const hit = this.keyAt(x, y); cv.style.cursor = hit ? 'pointer' : y < RULER_H && x > LABEL_W ? 'col-resize' : 'default'; return; }
      const r = d.rect || cv.getBoundingClientRect();
      this._pending = { x: e.clientX - r.left, y: e.clientY - r.top, alt: e.altKey };
      if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; const m = this._pending; this._pending = null; if (m && this.drag === d) this.applyMove(d, m); });
    });
    const up = () => { const d = this.drag; if (d) this.settle(d, false); };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('lostpointercapture', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x } = pos(e);
      if (e.ctrlKey) {
        const tAt = this.timeAt(x);
        this.pxPerSec = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.pxPerSec * Math.exp(-e.deltaY * 0.0015)));
        this.t0 = tAt - (x - LABEL_W) / this.pxPerSec;
      } else if (e.shiftKey) this.t0 += e.deltaY / this.pxPerSec * 0.6;
      else this.scrollY = Math.max(0, this.scrollY + e.deltaY * 0.5);
      this.draw();
    }, { passive: false });
    cv.addEventListener('dblclick', (e) => {
      const { x, y } = pos(e);
      const i = this.rowAt(y);
      const r = this.rows[i];
      if (r?.kind === 'node' && x > LABEL_W && !this.keyAt(x, y)) { ed.setTime(this.snap(this.timeAt(x), e)); ed.insertKeyframe([r.node.id]); }
    });
  }
  // one coalesced pointer move; `m` is relative to the canvas, movement is always measured from
  // the drag start (total offset), never from the previous snapped position
  applyMove(d, m) {
    const ed = this.editor, e = { altKey: m.alt };
    if (d.mode === 'pan') { this.t0 = d.t0 - (m.x - d.x) / this.pxPerSec; this.scrollY = Math.max(0, d.sy - (m.y - d.y)); this.draw(); }
    else if (d.mode === 'scrub') ed.setTime(Math.max(0, this.snap(this.timeAt(m.x), e)));
    else if (d.mode === 'move') {
      const dt = this.snapDelta(this.timeAt(m.x) - d.startT, e);
      if (dt !== d.lastDt) { ed.updateKeyDrag({ dt }); d.lastDt = dt; d.moved++; }
    } else if (d.mode === 'box') { d.cx = m.x; d.cy = m.y; this.draw(); }
  }
  snap(tm, e) { return e?.altKey ? snapTime(tm) : this.editor.timeOfFrame(Math.round(tm * this.editor.fps)); }
  snapDelta(dt, e) { return e?.altKey ? snapTime(dt) : Math.round(dt * this.editor.fps) / this.editor.fps; }
  keyMenu(e) {
    const ed = this.editor;
    const menu = showMenu({ x: e.clientX, y: e.clientY }, [
      { head: t('tl.interp') },
      ...INTERPOLATIONS.map((i) => ({ label: t('interp.' + i), action: () => ed.setKeyInterpolation(i) })),
      { sep: true },
      { label: t('menu.duplicateKeys'), action: () => ed.duplicateSelectedKeys() },
      { label: t('menu.copyKeys'), action: () => ed.copySelectedKeys() },
      { label: t('menu.deleteKeys'), action: () => ed.deleteSelectedKeys() },
    ]);
    return menu;
  }
}

function ellipsize(g, s, maxW) {
  if (g.measureText(s).width <= maxW) return s;
  while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
