// Application bootstrap: i18n, editor, viewport, panels, timeline, toolbar,
// keyboard shortcuts, layout persistence and session restore.
import { initI18n, setLanguage, currentLang, LANGS, t, onLangChange, applyI18n } from './i18n/i18n.js';
import { Editor } from './ui/editor.js';
import { Viewport } from './viewport/viewport.js';
import { initLeftPanels } from './ui/panels-left.js';
import { initRightPanels } from './ui/panels-right.js';
import { Timeline } from './ui/timeline.js';
import { initTutorial } from './ui/tutorial.js';
import { matchAction, showShortcutsDialog, primaryKeyLabel } from './ui/shortcuts.js';
import { showMenu, toast, confirmDialog } from './ui/dialogs.js';
import { h } from './ui/dom.js';
import { loadRecovery, listProjects, loadPrefs, updatePrefs } from './core/persistence.js';
import { initProjects } from './ui/projects.js';
import { activeClip } from './anim/clips.js';

async function main() {
  await initI18n();
  const editor = new Editor();
  window.editor = editor; // handy for debugging
  const viewport = new Viewport(editor, document.getElementById('viewport'));
  window.viewport = viewport;
  const timeline = new Timeline(editor, document.getElementById('timeline'));
  initLeftPanels(editor, viewport);
  initRightPanels(editor, viewport);
  initTutorial(editor);
  setupTopbar(editor);
  initProjects(editor);
  setupToolbar(editor, viewport);
  setupStatus(editor);
  setupLayout(editor);
  setupKeyboard(editor, viewport, timeline);
  setupFailsafes(editor);
  setupDrop(editor);
  setupEmptyState(editor);
  editor.setMode(loadPrefs().mode || 'rig');

  editor.on('framed', () => setTimeout(() => viewport.frameAll(), 60));

  // launch: Recent Projects screen when saved projects (or unsaved recovery data) exist;
  // otherwise the normal empty import experience. Nothing opens automatically.
  const [projects, recovery] = await Promise.all([listProjects(), loadRecovery()]);
  const hasContent = recovery && recovery.project && (recovery.project.nodes?.length || recovery.project.clips?.length);
  const recoverable = hasContent && (recovery.dirty === true || (recovery.dirty == null && !recovery.projectId));
  if (projects.length || recoverable) {
    const result = await editor.showStartScreen({ projects, recovery: recoverable ? recovery : null });
    if (result === 'opened' || result === 'recovered') setTimeout(() => viewport.frameAll(), 100);
  }
}

function setupTopbar(editor) {
  const sel = document.getElementById('lang-select');
  for (const l of LANGS) sel.append(h('option', { value: l.code, text: l.name, selected: l.code === currentLang() }));
  sel.addEventListener('change', () => setLanguage(sel.value, true));
  onLangChange((code) => { sel.value = code; });
  for (const b of document.querySelectorAll('#mode-tabs button')) b.addEventListener('click', () => { editor.setMode(b.dataset.mode); updatePrefs({ mode: b.dataset.mode }); });
  const leftScroll = document.querySelector('#left .rail-scroll');
  const order = { rig: ['panel-project', 'panel-outliner', 'panel-clips', 'panel-export'], animate: ['panel-clips', 'panel-outliner', 'panel-project', 'panel-export'], export: ['panel-export', 'panel-clips', 'panel-project', 'panel-outliner'] };
  const syncMode = () => {
    for (const b of document.querySelectorAll('#mode-tabs button')) b.classList.toggle('active', b.dataset.mode === editor.mode);
    for (const id of order[editor.mode] || order.rig) leftScroll.appendChild(document.getElementById(id));
    leftScroll.scrollTop = 0;
  };
  editor.on('mode', syncMode);
  syncMode();
  const undo = document.getElementById('btn-undo'), redo = document.getElementById('btn-redo');
  undo.addEventListener('click', () => editor.undo());
  redo.addEventListener('click', () => editor.redo());
  const syncHist = () => { undo.disabled = !editor.history.canUndo(); redo.disabled = !editor.history.canRedo(); };
  editor.history.onChange(syncHist);
  syncHist();
  document.getElementById('btn-shortcuts').addEventListener('click', () => showShortcutsDialog());
}

function setupToolbar(editor, viewport) {
  const bar = document.getElementById('vp-toolbar');
  const tb = (label, tip, onClick, opts = {}) => h('button', { class: 'tb-btn' + (opts.cls ? ' ' + opts.cls : ''), title: tip, onclick: onClick, html: label + (opts.key ? `<kbd>${opts.key}</kbd>` : '') });
  const build = () => {
    bar.innerHTML = '';
    const tools = h('div', { class: 'tb-group' },
      tb(t('tool.select'), t('tip.tool.select'), () => editor.setTool('select'), { key: primaryKeyLabel('tool.select'), cls: editor.tool === 'select' ? 'active' : '' }),
      tb(t('tool.move'), t('tip.tool.move') + ' \u00b7 ' + t('tip.tool.toggle', { k: primaryKeyLabel('tool.toggleMoveRotate') }), () => editor.setTool('move'), { key: primaryKeyLabel('tool.move'), cls: editor.tool === 'move' ? 'active' : '' }),
      editor.availableTools().includes('rotate') ? tb(t('tool.rotate'), t('tip.tool.rotate') + ' \u00b7 ' + t('tip.tool.toggle', { k: primaryKeyLabel('tool.toggleMoveRotate') }), () => editor.setTool('rotate'), { key: primaryKeyLabel('tool.rotate'), cls: editor.tool === 'rotate' ? 'active' : '' }) : null,
      editor.availableTools().includes('scale') ? tb(t('tool.scale'), t('tip.tool.scale'), () => editor.setTool('scale'), { key: primaryKeyLabel('tool.scale'), cls: editor.tool === 'scale' ? 'active' : '' }) : null,
    );
    const displayGroup = h('div', { class: 'tb-group' },
      tb(t('display.edit'), t('tip.display.edit', { k: primaryKeyLabel('tool.displayEdit') }), () => editor.toggleDisplayEdit(), { cls: editor.displayEdit ? 'pressed display-edit' : '' }),
    );
    const space = h('div', { class: 'tb-group' },
      tb(editor.space === 'world' ? t('space.world') : t('space.local'), t('tip.space', { k: primaryKeyLabel('tool.space') }), () => editor.toggleSpace(), { cls: editor.space === 'local' ? 'pressed' : '' }),
      tb(t('tool.snap'), t('tip.snap', { k: primaryKeyLabel('tool.snap') }), () => editor.setSnap({ enabled: !editor.snap.enabled }), { cls: editor.snap.enabled ? 'pressed' : '' }),
    );
    const rotMode = h('div', { class: 'tb-group' },
      tb(t(editor.rotateMode === 'preserve' ? 'rotmode.preserve' : 'rotmode.normal'), t('tip.rotmode'), () => editor.toggleRotateMode(), { cls: editor.rotateMode === 'preserve' ? 'pressed' : '' }),
    );
    const snapPos = h('input', { type: 'number', step: 0.01, min: 0.001, value: editor.snap.pos, title: t('tip.snapPos') });
    snapPos.addEventListener('change', () => editor.setSnap({ pos: Math.max(0.001, parseFloat(snapPos.value) || 0.1) }));
    const snapRot = h('input', { type: 'number', step: 1, min: 1, value: editor.snap.rot, title: t('tip.snapRot') });
    snapRot.addEventListener('change', () => editor.setSnap({ rot: Math.max(1, parseFloat(snapRot.value) || 15) }));
    for (const i of [snapPos, snapRot]) i.addEventListener('keydown', (e) => e.stopPropagation());
    space.append(snapPos, h('span', { style: 'font-size:10px;color:#6b7482', text: 'm' }), snapRot, h('span', { style: 'font-size:10px;color:#6b7482;padding-right:3px', text: '°' }));
    const view = h('div', { class: 'tb-group' },
      tb(t('view.frameSelected'), t('tip.view.frameSelected', { k: primaryKeyLabel('view.frameSelected') }), () => viewport.frameSelected()),
      tb(t('view.frameAll'), t('tip.view.frameAll', { k: primaryKeyLabel('view.frameAll') }), () => viewport.frameAll()),
      tb(t('view.views') + ' ▾', t('tip.view.views'), (e) => showMenu(e.currentTarget, [
        ...['front', 'back', 'right', 'left', 'top', 'bottom'].map((v) => ({ label: t('view.' + v), action: () => viewport.setView(v) })),
        { sep: true },
        { label: t('view.toggleProjection'), action: () => { viewport.cam.toggleProjection(); viewport.nav.syncBtn(); } },
      ])),
    );
    const add = h('div', { class: 'tb-group' },
      tb(t('add.menu') + ' ▾', t('tip.add.menu', { k: primaryKeyLabel('edit.add') }), (e) => addMenu(editor, e.currentTarget)),
    );
    bar.append(tools, displayGroup, space, rotMode, view, add);
  };
  build();
  editor.on('tool', build);
  editor.on('selection', build); // the available tools depend on what is selected
  onLangChange(build);
}

export function addMenu(editor, anchor) {
  showMenu(anchor, [
    { head: t('add.rigging') },
    { label: t('add.bone'), icon: '⌇', action: () => editor.addBone(editor.activeNode()?.type === 'bone' ? editor.active : null) },
    { label: t('add.bonesForSelected'), icon: '⌇', disabled: !editor.selectedNodes().some((n) => n.type === 'object'), action: () => editor.addBonesForSelected() },
    { label: t('add.target'), icon: '⊕', action: () => editor.addNode('target', { atActive: true }) },
    { label: t('add.pole'), icon: '◎', action: () => editor.addNode('pole', { atActive: true }) },
    { head: t('add.proxy') },
    { label: t('shape.cuboid'), icon: '◇', action: () => editor.addProxy('cuboid') },
    { label: t('shape.cylinder'), icon: '◇', action: () => editor.addProxy('cylinder') },
    { label: t('shape.sphere'), icon: '◇', action: () => editor.addProxy('sphere') },
    { head: t('panel.waypaths') },
    { label: t('path.addDirectional'), icon: '↝', action: () => editor.addWaypath('direction') },
    { label: t('path.addManual'), icon: '↝', action: () => editor.addWaypath('manual') },
  ]);
}

function setupStatus(editor) {
  const el = document.getElementById('vp-status');
  const render = () => {
    el.innerHTML = '';
    const node = editor.activeNode();
    const n = editor.selection.size;
    el.append(h('span', { text: node ? `${node.name} · ${t('type.' + node.type)}${n > 1 ? ` (+${n - 1})` : ''}` : t('status.nothingSelected') }));
    el.append(h('span', { text: `${t('tool.' + editor.tool)} · ${t('space.' + editor.space)}${editor.snap.enabled ? ' · ' + t('tool.snap') : ''}` }));
    if (editor.displayEdit) el.append(h('span', { class: 'display-edit', text: t('display.editing') }));
    if (editor.perfActive()) el.append(h('span', { class: 'perf', text: t('display.perfActive'), title: t('tip.display.perf') }));
    if (editor.rotateMode === 'preserve') el.append(h('span', { class: 'warn', text: t('rotmode.preserve') }));
    // viewport banner: unmistakable while the gizmos edit the display geometry
    const banner = document.getElementById('vp-mode-banner');
    if (banner) {
      const n = editor.displayEditNode();
      banner.hidden = !editor.displayEdit;
      const parts = editor.selectedDisplayParts();
      const partText = parts.length === 1 ? t('display.editingPart', { name: n.name, part: parts[0].name }) : parts.length > 1 ? t('display.editingParts', { name: n.name, n: parts.length }) : null;
      banner.textContent = editor.displayEdit ? (n ? (partText || t('display.editingOf', { name: n.name })) : t('display.editingSelect')) : '';
    }
    const c = activeClip(editor.project);
    if (c) el.append(h('span', { text: `${c.name} · ${editor.timeDisplay === 'frames' ? t('status.frame', { f: editor.frameOf(editor.time) }) : t('status.time', { s: editor.time.toFixed(2) })}` }));
    if (c && editor.project.settings.autoKey) el.append(h('span', { class: 'autokey', text: t('status.autoKey') }));
    if (editor.hint) el.append(h('span', { class: 'warn', text: editor.hint }));
    else el.append(h('span', { style: 'margin-left:auto;color:#6b7482', text: t('status.navHint') }));
  };
  editor.on('selection', render); editor.on('tool', render); editor.on('time', render); editor.on('change', render); editor.on('hint', render); editor.on('displaySel', render);
  onLangChange(render);
  render();
  let hintTimer = null;
  editor.on('hint', () => { clearTimeout(hintTimer); if (editor.hint) hintTimer = setTimeout(() => { editor.hint = ''; render(); }, 4000); });
}

function setupEmptyState(editor) {
  const el = document.getElementById('vp-empty');
  const render = () => {
    el.innerHTML = '';
    if (editor.project.nodes.length) return;
    el.append(t('viewport.empty'), h('small', { text: t('viewport.emptyHint') }));
  };
  editor.on('change', render); onLangChange(render); render();
}

function setupLayout(editor) {
  const prefs = loadPrefs();
  const left = document.getElementById('left'), right = document.getElementById('right'), tl = document.getElementById('timeline');
  if (prefs.leftW) left.style.width = prefs.leftW + 'px';
  if (prefs.rightW) right.style.width = prefs.rightW + 'px';
  if (prefs.tlH) tl.style.height = prefs.tlH + 'px';
  const drag = (handle, onMove, onEnd) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.classList.add('active');
      try { handle.setPointerCapture(e.pointerId); } catch {}
      const move = (ev) => onMove(ev);
      let done = false;
      const end = () => {
        if (done) return; done = true;
        handle.classList.remove('active');
        handle.removeEventListener('pointermove', move);
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.removeEventListener(type, end);
        try { if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId); } catch {}
        onEnd();
        editor.endInteraction('panel-resize');
      };
      handle.addEventListener('pointermove', move);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, end);
      editor.beginInteraction('panel-resize', { finish: end, pointerId: e.pointerId });
    });
  };
  drag(document.getElementById('resize-left'), (e) => { left.style.width = Math.max(240, Math.min(480, e.clientX - left.getBoundingClientRect().left)) + 'px'; }, () => updatePrefs({ leftW: left.offsetWidth }));
  drag(document.getElementById('resize-right'), (e) => { right.style.width = Math.max(220, Math.min(460, right.getBoundingClientRect().right - e.clientX)) + 'px'; }, () => updatePrefs({ rightW: right.offsetWidth }));
  drag(document.getElementById('timeline-resize'), (e) => { tl.classList.remove('collapsed'); tl.style.height = Math.max(90, Math.min(window.innerHeight * 0.6, tl.getBoundingClientRect().bottom - e.clientY)) + 'px'; }, () => updatePrefs({ tlH: tl.offsetHeight }));
  // remember collapsed panels
  for (const d of document.querySelectorAll('details.panel')) {
    const key = 'panel:' + d.id;
    if (prefs[key] != null) d.open = !!prefs[key];
    d.addEventListener('toggle', () => updatePrefs({ [key]: d.open }));
  }
}

function setupDrop(editor) {
  const vp = document.getElementById('viewport');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { depth++; vp.classList.add('dragover'); } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; vp.classList.remove('dragover'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; vp.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (/\.json$/i.test(f.name)) f.text().then((txt) => { try { editor.openProjectFile(txt); toast(t('toast.projectOpened')); } catch { toast(t('toast.projectOpenFailed'), 'error'); } });
    else editor.readFile(f, { guarded: true });
  });
}

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

// Recovery: a missed browser event (Alt-Tab mid-drag, pointer lost to another window,
// a dialog opening) must never leave a drag owning the pointer.
function setupFailsafes(editor) {
  window.addEventListener('blur', () => editor.finishInteraction());
  document.addEventListener('visibilitychange', () => { if (document.hidden) editor.finishInteraction(); });
  const lost = (e) => {
    const i = editor.interaction;
    if (!i) return;
    if (i.pointerId != null && e.pointerId !== i.pointerId) return;
    // bubble phase runs after the owner's own handler: only a stuck interaction is left
    setTimeout(() => { if (editor.interaction === i && !e.buttons) editor.finishInteraction(); }, 0);
  };
  window.addEventListener('pointerup', lost);
  window.addEventListener('pointercancel', lost);
  // dialogs (rename, confirmations, menus) take the pointer away from any drag
  const obs = new MutationObserver(() => { if (editor.interaction && document.querySelector('dialog[open], #start-screen, .menu')) editor.finishInteraction(); });
  obs.observe(document.body, { childList: true, subtree: false, attributes: true, attributeFilter: ['open'] });
}

function setupKeyboard(editor, viewport, timeline) {
  window.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+S saves the local project (never the browser's "Save page"), even from inputs
    const early = matchAction(e);
    if (early === 'file.save' || early === 'file.saveAs' || ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's')) {
      e.preventDefault();
      if (document.querySelector('dialog[open]') || document.getElementById('start-screen') || document.getElementById('tut-overlay')) return;
      if (isTyping()) document.activeElement.blur();
      if (early === 'file.save' || early === 'file.saveAs') editor.saveLocal({ as: early === 'file.saveAs' });
      return;
    }
    if (isTyping() || document.querySelector('dialog[open]') || document.getElementById('tut-overlay') || document.getElementById('start-screen')) return;
    // Escape cancels the active drag and restores its start pose; other shortcuts
    // (tool switch, frame step, undo…) first finish a transform so it cannot keep stale values
    if (e.key === 'Escape' && editor.interaction) { editor.cancelInteraction(); e.preventDefault(); return; }
    const action = early;
    if (!action) return;
    if (editor.interaction?.kind.startsWith('gizmo') || editor.interactionKind === 'panel-resize') editor.finishInteraction();
    const inTimeline = document.activeElement === timeline.canvas;
    const c = activeClip(editor.project);
    const handled = (() => {
      switch (action) {
        case 'tool.select': editor.setTool('select'); return true;
        case 'tool.move': editor.setTool('move'); return true;
        case 'tool.rotate': editor.setTool('rotate'); return true;
        case 'tool.scale': editor.setTool('scale'); return true;
        case 'tool.displayEdit': editor.toggleDisplayEdit(); return true;
        case 'tool.toggleMoveRotate':
          // Space in the timeline keeps its playback meaning; elsewhere it swaps Move/Rotate
          if (inTimeline) editor.togglePlay(); else { editor.cycleTool(); editor.setHint(t(editor.tool === 'rotate' ? 'hint.toolRotate' : editor.tool === 'scale' ? 'hint.toolScale' : 'hint.toolMove')); }
          return true;
        case 'tool.space': editor.toggleSpace(); return true;
        case 'tool.snap': editor.setSnap({ enabled: !editor.snap.enabled }); return true;
        case 'edit.undo': editor.undo(); return true;
        case 'edit.redo': editor.redo(); return true;
        case 'edit.delete': if (inTimeline || (editor.selectedKeys.size && !editor.selection.size)) editor.deleteSelectedKeys(); else if (editor.pathPointSel) editor.removePathPoint(editor.pathPointSel.wpId, editor.pathPointSel.index); else editor.deleteSelected?.(); return true;
        case 'edit.selectAll': if (inTimeline && c) editor.selectKeys(Object.entries(c.tracks).flatMap(([id, tr]) => [...tr.pos.map((k) => `${id}|pos|${k.t}`), ...tr.rot.map((k) => `${id}|rot|${k.t}`)])); else editor.selectAll(); return true;
        case 'edit.deselect': editor.deselectAll(); return true;
        case 'edit.rename': editor.renameActive?.(); return true;
        case 'edit.add': addMenu(editor, document.querySelector('#vp-toolbar .tb-group:last-child button')); return true;
        case 'edit.parent': { const ids = [...editor.selection].filter((id) => id !== editor.active); if (editor.active && ids.length) editor.reparentNodes(ids, editor.active); return true; }
        case 'edit.unparent': editor.reparentNodes([...editor.selection], null); return true;
        case 'anim.play': editor.togglePlay(); return true;
        case 'anim.stepBack': editor.stepFrames(-1); return true;
        case 'anim.stepForward': editor.stepFrames(1); return true;
        case 'anim.jumpStart': editor.pause(); editor.setTime(0); return true;
        case 'anim.jumpEnd': editor.pause(); if (c) editor.setTime(Math.max(0, c.duration)); return true;
        case 'anim.insertKey': editor.insertKeyframe(); return true;
        case 'anim.autoKey': editor.toggleAutoKey(); return true;
        case 'anim.copyKeys': editor.copySelectedKeys(); return true;
        case 'anim.pasteKeys': editor.pasteKeys(); return true;
        case 'anim.duplicateKeys': editor.duplicateSelectedKeys(); return true;
        case 'view.frameSelected': viewport.frameSelected(); return true;
        case 'view.frameAll': viewport.frameAll(); return true;
        case 'view.projection': viewport.cam.toggleProjection(); viewport.nav.syncBtn(); return true;
        case 'view.front': case 'view.back': case 'view.right': case 'view.left': case 'view.top': case 'view.bottom': viewport.setView(action.slice(5)); return true;
        case 'view.wasd': editor.setWasd(!editor.wasd); toast(t(editor.wasd ? 'toast.wasdOn' : 'toast.wasdOff'), 'info'); return true;
      }
      return false;
    })();
    if (handled) e.preventDefault();
  });
}

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre style="color:#e07a6e;padding:20px">${e.stack || e}</pre>`); });
