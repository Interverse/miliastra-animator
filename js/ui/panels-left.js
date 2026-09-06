// Left rail: Project (with the workflow guide), Outliner, Animations, Export (checklist).
import { t, onLangChange } from '../i18n/i18n.js';
import { h, row, numInput, textInput, selectInput, checkbox, button, btnRow, subhead, hint, empty, rerender, fmt } from './dom.js';
import { textPrompt, confirmDialog, showMenu, toast, messageDialog } from './dialogs.js';
import { getNode, childrenOf, orderedNodes, isAncestor } from '../scene/scene.js';
import { activeClip, getClip, clipEnd, track } from '../anim/clips.js';
import { modelInfo } from '../scene/primitives.js';
import { MAX_DEVICES_PER_OBJECT } from '../gia/motion-device.js';
import { hasErrors } from '../validation.js';
import { primaryKeyLabel } from './shortcuts.js';
import { downloadBytes } from './editor.js';
import { showRetargetDialog } from './retarget-dialog.js';
import { showPathLimitFlow } from './export-dialogs.js';
import { pathLimitViolations, MAX_PATH_POINTS, MAX_OBJECT_SCALE } from '../gia/gia-export.js';

const ICONS = { object: '▣', bone: '⌇', proxy: '◇', target: '⊕', pole: '◎', decoration: '·' };

export function initLeftPanels(editor, viewport) {
  const bodies = {
    project: document.querySelector('#panel-project .panel-body'),
    outliner: document.querySelector('#panel-outliner .panel-body'),
    clips: document.querySelector('#panel-clips .panel-body'),
    export: document.querySelector('#panel-export .panel-body'),
  };
  const counts = {
    outliner: document.querySelector('#panel-outliner .count'),
    clips: document.querySelector('#panel-clips .count'),
  };
  let validation = [];
  let exportPlan = null; // final path points per object/animation (rebuilt with the validation while the Export panel is open)
  let validationTimer = null;

  // ---------- Workflow guide ----------
  // Model → Rig → Animate → Export: where the project stands and the one next step
  // a beginner should take. Clicking a step opens that workspace.
  function workflowGuide() {
    const p = editor.project;
    const objs = p.nodes.filter((n) => n.type === 'object');
    const bones = p.nodes.filter((n) => n.type === 'bone');
    const keyed = p.clips.some((c) => Object.values(c.tracks).some((tr) => tr.pos.length || tr.rot.length));
    const done = { model: objs.length > 0, rig: bones.length > 0, animate: keyed, export: !!editor.lastReport };
    const steps = ['model', 'rig', 'animate', 'export'];
    const wrap = h('div', { class: 'guide' });
    const stepper = h('div', { class: 'guide-steps', role: 'tablist' });
    steps.forEach((m, i) => {
      const b = h('button', { class: 'guide-step' + (editor.mode === m ? ' current' : '') + (done[m] ? ' done' : ''), title: t('tip.mode.' + m), onclick: () => { editor.setMode(m); } },
        h('span', { class: 'guide-num', text: done[m] ? '✓' : String(i + 1) }), h('span', { class: 'guide-label', text: t('mode.' + m) }));
      stepper.append(b);
    });
    wrap.append(stepper);
    const next = !objs.length ? 'import' : !p.clips.length ? (bones.length ? 'animate' : 'rig') : !keyed ? 'keys' : !editor.lastReport ? 'export' : 'done';
    const nextMode = { import: 'model', rig: 'rig', animate: 'animate', keys: 'animate', export: 'export', done: null }[next];
    const line = h('div', { class: 'guide-next' }, h('span', { text: t('guide.next.' + next) }));
    if (nextMode && nextMode !== editor.mode) line.append(button(t('mode.' + nextMode) + ' →', () => editor.setMode(nextMode), { cls: 'mini' }));
    else if (next === 'import') line.append(button(t('viewport.import'), () => editor.pickGiaFile?.(), { cls: 'mini primary-mini' }));
    else if (next === 'animate') line.append(button(t('export.addAnimation'), () => editor.createClip(), { cls: 'mini primary-mini' }));
    else if (next === 'export') line.append(button(t('export.download'), () => { editor.setMode('export'); document.getElementById('btn-export')?.focus(); }, { cls: 'mini' }));
    wrap.append(line);
    if (next === 'rig') wrap.append(hint(t('guide.optional')));
    return wrap;
  }

  // ---------- Project ----------
  function renderProject(body) {
    const p = editor.project;
    body.append(workflowGuide());
    const input = h('input', { type: 'file', accept: '.gia' });
    input.addEventListener('change', () => { const f = input.files[0]; if (f) readFile(f, { guarded: true }); input.value = ''; });
    editor.pickGiaFile = () => input.click();
    const drop = h('label', { class: 'filedrop' }, h('span', { text: t('project.drop') }), h('span', { class: 'hint', text: t('project.dropHint') }), input);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f) readFile(f, { guarded: true }); });
    body.append(drop);
    const objs = p.nodes.filter((n) => n.type === 'object');
    const decs = objs.reduce((a, o) => a + (o.decorations?.length || 0), 0);
    const hasContent = objs.length || p.clips.length;
    body.append(h('div', { class: 'stat-grid' },
      h('span', { class: 'k', text: t('project.name') }), h('span', { class: 'v', text: hasContent ? (editor.projectName || editor.defaultProjectName()) : '—', title: editor.projectName || '' }),
      h('span', { class: 'k', text: t('project.state') }), h('span', { class: 'v' + (editor.dirty ? ' warn' : ''), text: hasContent ? t(editor.dirty ? 'project.stateUnsaved' : 'project.stateSaved') : '—' }),
      h('span', { class: 'k', text: t('project.file') }), h('span', { class: 'v', text: editor.giaName || '—', title: editor.giaName || '' }),
      h('span', { class: 'k', text: t('project.objects') }), h('span', { class: 'v', text: String(objs.length) }),
      h('span', { class: 'k', text: t('project.decorations') }), h('span', { class: 'v', text: String(decs) }),
      h('span', { class: 'k', text: t('project.clips') }), h('span', { class: 'v', text: String(p.clips.length) }),
    ));
    if (editor.importInfo?.controllerFound) body.append(hint(t('project.controllerNote')));
    const projInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    projInput.addEventListener('change', async () => { const f = projInput.files[0]; if (!f) return; try { editor.openProjectFile(await f.text()); toast(t('toast.projectOpened')); } catch (e) { toast(t('toast.projectOpenFailed'), 'error'); } projInput.value = ''; });
    body.append(projInput);
    editor.pickProjectFile = () => projInput.click();
    editor.exportProjectFile = () => downloadBytes(new TextEncoder().encode(editor.projectFileJSON()), (editor.projectName || editor.giaName || 'project').replace(/\.gia$/i, '') + '.animator.json', 'application/json');
    body.append(btnRow(
      button(`${t('project.saveLocal')} (${primaryKeyLabel('file.save')})`, () => editor.saveLocal(), { cls: hasContent && editor.dirty ? 'mini primary-mini' : 'mini', disabled: !hasContent, tip: t('tip.project.saveLocal') }),
      button(t('project.saveAs') + '…', () => editor.saveLocal({ as: true }), { disabled: !hasContent, tip: t('tip.project.saveAs') }),
    ));
    body.append(btnRow(button(t('project.allProjects') + '…', () => editor.showProjectsDialog?.(), { tip: t('tip.projects') })));
    body.append(hint(t('project.localHint')));
    body.append(btnRow(
      button(t('project.save'), () => editor.exportProjectFile(), { tip: t('tip.project.save'), disabled: !hasContent }),
      button(t('project.open'), () => projInput.click(), { tip: t('tip.project.open') }),
    ));
    body.append(btnRow(
      button(t('project.new'), async () => { if (await (editor.guardUnsaved ? editor.guardUnsaved() : confirmDialog({ title: t('project.new'), message: t('project.newConfirm'), danger: true }))) editor.newProject(); }, { tip: t('tip.project.new') }),
      button(t('project.clearSaved'), async () => { if (await confirmDialog({ title: t('project.clearSaved'), message: t('project.clearConfirm'), danger: true })) { await editor.clearSaved(); toast(t('toast.savedCleared'), 'info'); } }, { tip: t('tip.project.clearSaved') }),
    ));
    body.append(hint(t('project.autosaveHint')));
  }
  async function readFile(file, { guarded = false } = {}) {
    if (!/\.gia$/i.test(file.name)) { toast(t('toast.notGia'), 'warn'); return; }
    if (guarded && editor.guardUnsaved && !(await editor.guardUnsaved())) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    if (editor.importGia(buf, file.name)) { setTimeout(() => viewport.frameAll(), 50); editor.setMode('model'); }
  }
  editor.readFile = readFile;

  // ---------- Outliner ----------
  let dragIds = null;
  function renderOutliner(body) {
    const p = editor.project;
    const clip = activeClip(p);
    body.append(btnRow(
      button(t('add.bone'), () => editor.addBone(editor.activeNode()?.type === 'bone' ? editor.active : null), { tip: t('tip.add.bone') }),
      button(t('add.proxy') + ' ▾', (e) => showMenu(e.currentTarget, [
        { label: t('shape.cuboid'), action: () => editor.addProxy('cuboid') },
        { label: t('shape.cylinder'), action: () => editor.addProxy('cylinder') },
        { label: t('shape.sphere'), action: () => editor.addProxy('sphere') },
      ]), { tip: t('tip.add.proxy') }),
      button(t('add.target'), () => editor.addNode('target', { atActive: true }), { tip: t('tip.add.target') }),
      button(t('add.pole'), () => editor.addNode('pole', { atActive: true }), { tip: t('tip.add.pole') }),
    ));
    if (!p.nodes.length) { body.append(empty(t('outliner.empty'))); return; }
    const list = h('div', { class: 'list outliner-list' });
    const rows = orderedNodes(p);
    // only an explicitly collapsed node hides its child nodes; decoration lists are collapsed by default
    const collapsedAncestor = (node) => { let cur = node; let g = 0; while (cur.parent && g++ < 1000) { if (editor.collapsed.has(cur.parent)) return true; cur = getNode(p, cur.parent); if (!cur) break; } return false; };
    for (const { node, depth } of rows) {
      if (collapsedAncestor(node)) continue;
      const kids = childrenOf(p, node.id).length;
      const decs = node.type === 'object' ? node.decorations?.length || 0 : 0;
      const expandable = kids > 0 || decs > 0;
      const open = editor.isOutlinerOpen(node);
      const showDecos = decs > 0 && editor.expandedDecos.has(node.id);
      const tr = clip && track(clip, node.id);
      const keyed = !!(tr && (tr.pos.length || tr.rot.length));
      const rowEl = h('div', { class: 'list-row' + (editor.selection.has(node.id) ? ' selected' : '') + (editor.active === node.id ? ' active' : ''), draggable: true, dataset: { id: node.id }, style: `padding-left:${4 + depth * 14}px` },
        h('span', { class: 'twisty', text: expandable ? (open ? '▾' : '▸') : '', title: expandable ? t(open ? 'outliner.collapse' : 'outliner.expand') : null, onclick: (e) => { e.stopPropagation(); editor.toggleOutliner(node.id); } }),
        h('span', { class: 'ico ' + node.type, text: ICONS[node.type] || '•', title: t('type.' + node.type) }),
        h('span', { class: 'name', text: decs && !showDecos ? `${node.name} (${decs})` : node.name, title: decs ? `${node.name} · ${t('outliner.decoCount', { n: decs })}` : node.name }),
        keyed ? h('span', { class: 'meta', text: '◆', style: 'color:#f5a623', title: t('outliner.keyed') }) : null,
        node.type === 'object' && node.isStatic ? h('span', { class: 'chip warn', text: t('outliner.static'), title: t('tip.static') }) : null,
        h('span', { class: 'vis' + (node.hidden ? ' off' : ''), text: node.hidden ? '◌' : '◉', title: t('tip.visibility'), onclick: (e) => { e.stopPropagation(); editor.setNodeHidden(node.id, !node.hidden); } }),
      );
      rowEl.addEventListener('click', (e) => editor.select(node.id, e.shiftKey ? 'add' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'replace'));
      rowEl.addEventListener('dblclick', () => startRename(rowEl, node));
      rowEl.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!editor.selection.has(node.id)) editor.select(node.id); nodeMenu(rowEl, node); });
      rowEl.addEventListener('dragstart', (e) => { if (!editor.selection.has(node.id)) editor.select(node.id); dragIds = [...editor.selection]; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', node.id); });
      rowEl.addEventListener('dragover', (e) => { if (!dragIds || dragIds.includes(node.id)) return; e.preventDefault(); rowEl.classList.add('drop-into'); });
      rowEl.addEventListener('dragleave', () => rowEl.classList.remove('drop-into'));
      rowEl.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); rowEl.classList.remove('drop-into'); if (dragIds) { editor.reparentNodes(dragIds, node.id); dragIds = null; } });
      list.append(rowEl);
      if (showDecos) {
        const shown = node.decorations.slice(0, 40);
        for (const d of shown) {
          const info = modelInfo(d.modelId);
          list.append(h('div', { class: 'list-row decoration', style: `padding-left:${18 + depth * 14}px`, title: `${d.name} · ${info ? info.name : t('outliner.unknownModel')} (${d.modelId})` },
            h('span', { class: 'ico decoration', text: ICONS.decoration }), h('span', { class: 'name', text: d.name }), h('span', { class: 'meta', text: info ? info.name : String(d.modelId) })));
        }
        if (node.decorations.length > shown.length) list.append(h('div', { class: 'list-row decoration', style: `padding-left:${18 + depth * 14}px` }, h('span', { class: 'meta', text: t('outliner.more', { n: node.decorations.length - shown.length }) })));
      }
    }
    list.addEventListener('dragover', (e) => { if (dragIds) { e.preventDefault(); } });
    list.addEventListener('drop', (e) => { e.preventDefault(); if (dragIds) { editor.reparentNodes(dragIds, null); dragIds = null; } });
    body.append(list);
    const footer = h('div', { class: 'outliner-footer' });
    renderOutlinerFooter(footer);
    body.append(footer);
    body.append(hint(t('outliner.dragHint')));
  }
  // selection-dependent buttons live in their own container so a selection change
  // never rebuilds (and never scrolls) the tree itself
  function renderOutlinerFooter(footer) {
    const p = editor.project;
    footer.innerHTML = '';
    const sel = [...editor.selection];
    const act = editor.activeNode();
    const selObjects = sel.filter((id) => getNode(p, id)?.type === 'object').length;
    footer.append(btnRow(button(t('add.bonesForSelected'), () => editor.addBonesForSelected(), { disabled: !selObjects, tip: t('tip.add.bonesForSelected') })));
    footer.append(btnRow(
      button(t('outliner.parent'), () => editor.reparentNodes(sel.filter((id) => id !== editor.active), editor.active), { disabled: sel.length < 2 || !act, tip: t('tip.outliner.parent', { k: primaryKeyLabel('edit.parent') }) }),
      button(t('outliner.unparent'), () => editor.reparentNodes(sel, null), { disabled: !sel.some((id) => getNode(p, id)?.parent), tip: t('tip.outliner.unparent', { k: primaryKeyLabel('edit.unparent') }) }),
      button(t('btn.delete'), () => deleteSelected(), { disabled: !sel.length, cls: 'mini danger', tip: t('tip.outliner.delete') }),
    ));
  }
  // Selection change: toggle classes on the existing rows, keep the scroll position, and
  // only nudge the active row into view (minimal movement) when it is out of sight.
  function syncOutlinerSelection() {
    const list = bodies.outliner.querySelector('.outliner-list');
    if (!list) { renderAll(['outliner']); return; }
    for (const row of list.querySelectorAll('.list-row[data-id]')) {
      const id = row.dataset.id;
      row.classList.toggle('selected', editor.selection.has(id));
      row.classList.toggle('active', editor.active === id);
    }
    const footer = bodies.outliner.querySelector('.outliner-footer');
    if (footer) renderOutlinerFooter(footer);
    if (editor.active) {
      const row = list.querySelector(`.list-row[data-id="${CSS.escape(editor.active)}"]`);
      if (row) {
        const lr = list.getBoundingClientRect(), rr = row.getBoundingClientRect();
        const scroller = list.scrollHeight > list.clientHeight ? list : list.closest('.rail-scroll');
        const sr = scroller ? scroller.getBoundingClientRect() : lr;
        if (rr.top < sr.top || rr.bottom > sr.bottom) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }
  async function deleteSelected() {
    const ids = [...editor.selection];
    if (!ids.length) return;
    const hasObject = ids.some((id) => getNode(editor.project, id)?.type === 'object');
    if (hasObject && !(await confirmDialog({ title: t('btn.delete'), message: t('outliner.deleteObjectConfirm'), danger: true }))) return;
    editor.deleteNodes(ids);
  }
  editor.deleteSelected = deleteSelected;
  function startRename(rowEl, node) {
    const nameEl = rowEl.querySelector('.name');
    const inp = h('input', { class: 'rename', type: 'text', value: node.name });
    nameEl.replaceWith(inp);
    inp.focus(); inp.select();
    const done = (save) => { if (save && inp.value.trim()) editor.renameNode(node.id, inp.value.trim()); else renderAll(['outliner']); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
    inp.addEventListener('click', (e) => e.stopPropagation());
  }
  editor.renameActive = () => { const act = editor.activeNode(); if (!act) return; const rowEl = bodies.outliner.querySelector(`.list-row[data-id="${act.id}"]`); if (rowEl) startRename(rowEl, act); else textPrompt({ title: t('menu.rename'), value: act.name }).then((v) => v && editor.renameNode(act.id, v)); };
  function nodeMenu(anchor, node) {
    const sel = [...editor.selection];
    showMenu(anchor, [
      { label: t('menu.rename'), action: () => startRename(anchor, node) },
      { label: t('menu.addChildBone'), action: () => editor.addBone(node.id) },
      node.type === 'bone' ? { label: t('menu.addIK'), action: () => editor.addConstraint(node.id) } : null,
      { label: t('menu.selectChildren'), action: () => editor.select(editor.project.nodes.filter((n) => isAncestor(editor.project, node.id, n.id)).map((n) => n.id), 'add') },
      { sep: true },
      { label: t('outliner.parent'), disabled: sel.length < 2, action: () => editor.reparentNodes(sel.filter((id) => id !== node.id), node.id) },
      { label: t('outliner.unparent'), disabled: !node.parent, action: () => editor.reparentNodes([node.id], null) },
      { label: t('view.frameSelected'), action: () => viewport.frameNodes([node.id]) },
      { sep: true },
      { label: t('btn.delete'), action: () => deleteSelected() },
    ].filter(Boolean));
  }

  // ---------- Animations ----------
  function renderClips(body) {
    const p = editor.project;
    const active = activeClip(p);
    const importSection = () => {
      body.append(subhead(t('clip.importHead')));
      body.append(btnRow(button(t('retarget.button'), () => showRetargetDialog(editor), { tip: t('tip.retarget.button') })));
      body.append(hint(t('clip.importHint')));
    };
    if (!p.clips.length) {
      body.append(empty(t('clip.emptyTitle')));
      body.append(hint(t(p.nodes.length ? 'clip.empty' : 'clip.emptyNoModel')));
      body.append(btnRow(button(t('export.addAnimation'), () => editor.createClip(), { cls: 'mini primary-mini', tip: t('tip.clip.new') })));
      importSection();
      return;
    }
    body.append(btnRow(
      button(t('export.addAnimation'), () => editor.createClip(), { tip: t('tip.clip.new') }),
      button(t('clip.duplicate'), () => active && editor.duplicateClip(active.id), { disabled: !active, tip: t('tip.clip.duplicate') }),
      button(t('clip.rename'), async () => { if (!active) return; const v = await textPrompt({ title: t('clip.rename'), value: active.name }); if (v) editor.renameClip(active.id, v); }, { disabled: !active }),
      button(t('btn.delete'), async () => { if (!active) return; if (await confirmDialog({ title: t('btn.delete'), message: t('clip.deleteConfirm', { name: active.name }), danger: true })) editor.deleteClip(active.id); }, { disabled: !active, cls: 'mini danger' }),
    ));
    const list = h('div', { class: 'list' });
    for (const c of p.clips) {
      const keys = Object.values(c.tracks).reduce((a, tr) => a + tr.pos.length + tr.rot.length, 0);
      const r = h('div', { class: 'list-row' + (c.id === p.activeClipId ? ' active' : '') },
        h('span', { class: 'ico', text: c.id === p.activeClipId ? '▶' : '·' }),
        h('span', { class: 'name', text: c.name, title: c.name }),
        h('span', { class: 'meta', text: fmt(clipEnd(c), 2) + 's · ' + keys + '◆' }),
        c.loop ? h('span', { class: 'chip loop', text: t('clip.loop') }) : null,
        editor.clipHasRootMotion(c) ? h('span', { class: 'chip' + (c.rootMotion === false ? '' : ' loop'), text: t(c.rootMotion === false ? 'clip.rootOff' : 'clip.rootOn'), title: t('tip.clip.rootMotion') }) : null,
      );
      r.addEventListener('click', () => editor.setActiveClip(c.id));
      r.addEventListener('dblclick', async () => { const v = await textPrompt({ title: t('clip.rename'), value: c.name }); if (v) editor.renameClip(c.id, v); });
      list.append(r);
    }
    body.append(list);
    if (active) {
      body.append(row(t('clip.duration'), numInput(active.duration, (v) => editor.setClipProps(active.id, { duration: Math.max(0.03, v) }), { step: 0.1, min: 0.03, precision: 2 }), t('tip.clip.duration')));
      body.append(checkbox(t('clip.loopPlayback'), active.loop, (v) => editor.setClipProps(active.id, { loop: v }), t('tip.clip.loop')));
      if (editor.clipHasRootMotion(active)) {
        const rootName = getNode(p, editor.clipRootNode(active))?.name || '?';
        body.append(checkbox(t('clip.rootMotion', { node: rootName }), active.rootMotion !== false, (v) => editor.setClipRootMotion(active.id, v), t('tip.clip.rootMotion')));
        body.append(hint(t(active.rootMotion === false ? 'clip.rootMotionOffHint' : 'clip.rootMotionOnHint')));
      }
    }
    body.append(hint(t('clip.activeHint', { name: active ? active.name : '—' })));
    importSection();
  }

  // ---------- Export ----------
  function renderExport(body) {
    const p = editor.project;
    const slots = editor.slots;
    const cfg = p.exportConfig;
    const n = slots.length;
    body.append(hint(t('export.intro')));
    // --- checklist: everything the file needs before it can be downloaded ---
    const errs0 = validation.filter((i) => i.level === 'error'), warns0 = validation.filter((i) => i.level === 'warning');
    const pathOver = exportPlan ? pathLimitViolations(exportPlan) : [];
    const scaleOver = editor.objectScaleViolations();
    const scrollTo = (el) => el && el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const items = [
      { state: editor.giaBytes ? 'ok' : 'bad', label: t('export.check.model'), action: () => editor.setMode('model') },
      { state: n ? 'ok' : 'bad', label: t('export.check.anims', { n, max: MAX_DEVICES_PER_OBJECT }), action: () => scrollTo(body.querySelector('.slot') || body.querySelector('.limit-bar')) },
      { state: n ? 'ok' : 'todo', label: t('export.check.initial', { name: n ? (slots[cfg.initialSlot | 0] || slots[0])?.name || getClip(p, (slots[cfg.initialSlot | 0] || slots[0])?.clipId)?.name || '' : '—' }), action: () => scrollTo(body.querySelector('.slot.initial')) },
      { state: !exportPlan ? 'todo' : pathOver.length ? 'warn' : 'ok', label: pathOver.length ? t('export.check.pathsOver', { n: pathOver.length, max: MAX_PATH_POINTS }) : t('export.check.paths', { max: MAX_PATH_POINTS }), action: () => { if (pathOver.length) editor.select(pathOver.map((o) => o.nodeId).filter(Boolean)); } },
      { state: scaleOver.length ? 'bad' : 'ok', label: scaleOver.length ? t('export.check.scaleOver', { n: scaleOver.length, max: MAX_OBJECT_SCALE }) : t('export.check.scale', { max: MAX_OBJECT_SCALE }), action: () => { if (scaleOver.length) editor.select(scaleOver.map((o) => o.nodeId)); else editor.setMode('model'); } },
      { state: errs0.length ? 'bad' : warns0.length ? 'warn' : 'ok', label: errs0.length ? t('export.validationErrors', { n: errs0.length }) : warns0.length ? t('export.validationWarnings', { n: warns0.length }) : t('export.validationOk'), action: () => scrollTo(body.querySelector('.validation-list')) },
    ];
    const ICON = { ok: '✓', warn: '⚠', bad: '✕', todo: '○' };
    const check = h('div', { class: 'checklist' });
    for (const it of items) check.append(h('button', { class: 'check-item ' + it.state, onclick: it.action, title: t('export.check.tip') }, h('span', { class: 'check-ico', text: ICON[it.state] }), h('span', { class: 'check-label', text: it.label })));
    body.append(check);
    body.append(subhead(t('export.animations'), h('span', { class: 'count', style: 'margin-left:auto', text: `${n} / ${MAX_DEVICES_PER_OBJECT}` })));
    const bar = h('div', { class: 'limit-bar' });
    for (let i = 0; i < MAX_DEVICES_PER_OBJECT; i++) bar.append(h('i', { class: i < n ? 'used' : '' }));
    body.append(bar);
    body.append(hint(t('export.limitHint', { max: MAX_DEVICES_PER_OBJECT })));
    if (!p.clips.length) body.append(empty(t('export.noClips')));
    slots.forEach((s, i) => {
      const clip = getClip(p, s.clipId);
      const isInitial = (cfg.initialSlot | 0) === i;
      const el = h('div', { class: 'slot' + (isInitial ? ' initial' : '') });
      const radio = h('input', { type: 'radio', name: 'initial-slot', checked: isInitial, title: t('tip.export.initial') });
      radio.addEventListener('change', () => editor.setExportOption({ initialSlot: i }));
      el.append(h('div', { class: 'slot-head' }, radio, h('span', { class: 'name', text: `${i + 1}. ${s.name || clip?.name || ''}` }),
        button('↑', () => editor.moveSlot(i, -1), { disabled: i === 0, tip: t('tip.export.moveUp') }),
        button('↓', () => editor.moveSlot(i, 1), { disabled: i === n - 1, tip: t('tip.export.moveDown') }),
        button('✕', () => editor.removeSlot(i), { cls: 'mini danger', tip: t('tip.export.remove') })));
      el.append(row(t('export.slotClip'), selectInput(p.clips.map((c) => ({ value: c.id, label: c.name })), s.clipId, (v) => editor.updateSlot(i, { clipId: v })), t('tip.export.slotClip')));
      el.append(row(t('export.slotName'), textInput(s.name || clip?.name || '', (v) => editor.updateSlot(i, { name: v.trim() })), t('tip.export.slotName')));
      const rotRow = row(t('export.outputRotation'), numInput(s.outputYaw || 0, (v) => editor.updateSlot(i, { outputYaw: v }), { step: 15, precision: 2, width: 70 }), t('tip.export.outputRotation'));
      const previewing = editor.exportPreviewSlot === i;
      rotRow.append(button(previewing ? t('export.previewOn') : t('export.preview'), () => editor.setExportPreview(previewing ? null : i), { cls: previewing ? 'mini primary-mini' : 'mini', tip: t('tip.export.preview') }));
      el.append(rotRow);
      if (previewing) el.append(hint(t('export.previewHint', { deg: fmt(s.outputYaw || 0, 2) }), 'warn'));
      if (clip) el.append(hint(t('export.slotInfo', { dur: fmt(clipEnd(clip), 2), loop: clip.loop ? t('clip.loop') : t('clip.once') })));
      // final path point counts for this animation (from the export plan; the limit is per object path)
      const devs = exportPlan ? exportPlan.devices.filter((d) => d.slotIndex === i) : [];
      if (devs.length) {
        const maxRaw = Math.max(...devs.map((d) => d.rawCount)), maxFinal = Math.max(...devs.map((d) => d.points.length));
        const over = maxFinal > MAX_PATH_POINTS;
        el.append(hint(t('export.pathPoints', { n: maxFinal, max: MAX_PATH_POINTS, objs: devs.length }) + (s.compress && maxRaw !== maxFinal ? ' · ' + t('export.pathPointsCompressed', { from: maxRaw }) : ''), over ? 'warn' : ''));
        if (over) el.append(hint(t('export.pathPointsOver', { max: MAX_PATH_POINTS }), 'warn'));
        el.append(checkbox(t('export.autoCompress', { max: MAX_PATH_POINTS }), !!s.compress, (v) => editor.setSlotCompression([i], v), t('tip.export.autoCompress')));
        const failed = devs.filter((d) => d.compression?.auto && !d.compression.ok);
        if (failed.length) el.append(hint(t('export.autoCompressFailed', { n: failed.length }), 'err'));
      }
      body.append(el);
    });
    // with no animations yet this creates the first one (which also becomes an export slot)
    body.append(btnRow(button(t('export.addAnimation'), () => { if (p.clips.length) editor.addSlot(activeClip(p)?.id || p.clips[0].id); else editor.createClip(); }, { disabled: n >= MAX_DEVICES_PER_OBJECT, tip: t(p.clips.length ? 'tip.export.add' : 'tip.clip.new') })));
    if (n) body.append(hint(t('export.initialHint')));

    const adv = h('details', null, h('summary', { text: t('export.options'), style: 'font-size:12px;color:#9aa3b0;cursor:pointer;margin:8px 0 4px' }));
    adv.append(checkbox(t('export.switching'), cfg.switching !== false, (v) => editor.setExportOption({ switching: v }), t('tip.export.switching')));
    adv.append(row(t('export.precision'), selectInput([{ value: 'low', label: t('precision.low') }, { value: 'normal', label: t('precision.normal') }, { value: 'high', label: t('precision.high') }], cfg.precision || 'normal', (v) => editor.setExportOption({ precision: v })), t('tip.export.precision')));
    adv.append(row(t('export.relativeFrame'), selectInput([{ value: 'world', label: t('frame.world') }, { value: 'local', label: t('frame.local') }], p.settings.relativeFrame || 'world', (v) => editor.setSetting('relativeFrame', v)), t('tip.export.relativeFrame')));
    adv.append(hint(t('export.runtimeHint')));
    body.append(adv);

    body.append(subhead(t('export.validation')));
    body.classList.add('has-checklist');
    const errs = validation.filter((i) => i.level === 'error').length, warns = validation.filter((i) => i.level === 'warning').length;
    if (!validation.length) body.append(hint(t('export.validationOk'), 'ok'));
    else {
      body.append(hint(errs ? t('export.validationErrors', { n: errs }) : warns ? t('export.validationWarnings', { n: warns }) : t('export.validationInfo'), errs ? 'err' : warns ? 'warn' : ''));
      const list = h('div', { class: 'validation-list' });
      for (const i of validation.slice(0, 30)) {
        const el = h('div', { class: 'issue ' + i.level }, h('span', { class: 'lvl', text: i.level === 'error' ? '✕' : i.level === 'warning' ? '⚠' : 'ℹ' }), h('span', { class: 'msg', text: t(i.key, i.params) }));
        if (i.nodeId) el.append(h('span', { class: 'go', text: '→', title: t('tip.issue.go'), onclick: () => editor.select(i.nodeId) }));
        if (i.clipId) el.append(h('span', { class: 'go', text: '→', title: t('tip.issue.go'), onclick: () => editor.setActiveClip(i.clipId) }));
        list.append(el);
      }
      body.append(list);
    }
    body.append(hint(t('export.levels')));
    if (exportPlan) {
      const over = pathLimitViolations(exportPlan);
      if (over.length) body.append(hint(t('export.limitSummary', { n: over.length, max: MAX_PATH_POINTS }), 'warn'));
    }
    const canExport = !!editor.giaBytes && !hasErrors(validation) && n > 0;
    const btn = button(t('export.download'), () => editor.exportFile(), { cls: 'success primary-big', disabled: !canExport, tip: t('tip.export.download') });
    btn.id = 'btn-export';
    body.append(btn);
    if (editor.lastReport) {
      const r = editor.lastReport;
      body.append(subhead(t('export.report')));
      body.append(h('div', { class: 'stat-grid' },
        h('span', { class: 'k', text: t('export.reportParts') }), h('span', { class: 'v', text: String(r.parts.length) }),
        h('span', { class: 'k', text: t('export.reportDevices') }), h('span', { class: 'v', text: String(r.devices) }),
        h('span', { class: 'k', text: t('export.reportPoints') }), h('span', { class: 'v', text: String(r.parts.reduce((a, q) => a + q.points.reduce((x, y) => x + y, 0), 0)) }),
        h('span', { class: 'k', text: t('export.reportInitial') }), h('span', { class: 'v', text: r.controller?.initial || '—' }),
      ));
      if (r.warnings.length) body.append(hint(t('export.reportWarnings', { n: r.warnings.length }), 'warn'));
      body.append(hint(t('export.reportHint')));
    }
  }

  function scheduleValidation() {
    clearTimeout(validationTimer);
    validationTimer = setTimeout(() => { validation = editor.validate(); exportPlan = editor.mode === 'export' ? editor.exportPlan() : null; rerender(bodies.export, renderExport); scheduleFit(); }, 250);
  }
  editor.resolvePathLimit = (plan, over) => showPathLimitFlow(editor, plan, over);

  // ---------- Outliner vertical fit ----------
  // The outliner list takes whatever height the left rail has left after the
  // other panels and the outliner's own header/buttons, so large hierarchies
  // reach the bottom of the workspace and scroll internally only when they
  // really exceed it. When the leftover is too small the list keeps its natural
  // height and the rail scrolls instead (never two nested scrollbars).
  const rail = document.querySelector('#left .rail-scroll');
  const outlinerPanel = document.getElementById('panel-outliner');
  const MIN_FILL = 160;
  let fitPending = false;
  function fitOutliner() {
    fitPending = false;
    const list = bodies.outliner.querySelector('.outliner-list');
    if (!list || !outlinerPanel.open || outlinerPanel.offsetParent === null) return;
    const railStyle = getComputedStyle(rail);
    const gap = parseFloat(railStyle.rowGap || railStyle.gap) || 0;
    const pad = (parseFloat(railStyle.paddingTop) || 0) + (parseFloat(railStyle.paddingBottom) || 0);
    let others = 0, count = 0;
    for (const el of rail.children) {
      if (el.offsetParent === null) continue;
      count++;
      if (el !== outlinerPanel) others += el.offsetHeight;
    }
    const chrome = outlinerPanel.offsetHeight - list.offsetHeight;
    const leftover = rail.clientHeight - pad - gap * Math.max(0, count - 1) - others - chrome;
    if (leftover >= MIN_FILL) list.style.height = Math.floor(leftover) + 'px';
    else list.style.height = '';
  }
  function scheduleFit() {
    if (fitPending) return;
    fitPending = true;
    requestAnimationFrame(fitOutliner);
  }
  new ResizeObserver(scheduleFit).observe(rail);
  window.addEventListener('resize', scheduleFit);
  for (const d of rail.querySelectorAll('details.panel')) d.addEventListener('toggle', scheduleFit);
  editor.on('mode', () => { scheduleFit(); setTimeout(scheduleFit, 50); scheduleValidation(); });

  function renderAll(which = ['project', 'outliner', 'clips', 'export']) {
    if (which.includes('project')) rerender(bodies.project, renderProject);
    if (which.includes('outliner')) {
      const prev = bodies.outliner.querySelector('.outliner-list');
      const keepScroll = prev ? prev.scrollTop : 0;
      rerender(bodies.outliner, renderOutliner);
      const next = bodies.outliner.querySelector('.outliner-list');
      if (next && keepScroll) { next.scrollTop = keepScroll; requestAnimationFrame(() => { next.scrollTop = keepScroll; }); }
      counts.outliner.textContent = editor.project.nodes.length ? String(editor.project.nodes.length) : '';
    }
    if (which.includes('clips')) { rerender(bodies.clips, renderClips); counts.clips.textContent = editor.project.clips.length ? String(editor.project.clips.length) : ''; }
    if (which.includes('export')) scheduleValidation();
    scheduleFit();
  }
  editor.on('change', (d) => { if (d?.transient) return; renderAll(); });
  editor.on('selection', () => syncOutlinerSelection());
  editor.on('outliner', () => renderAll(['outliner']));
  editor.on('export', () => renderAll(['export']));
  editor.on('preview', () => renderAll(['export']));
  editor.on('dirty', () => renderAll(['project']));
  editor.on('mode', () => renderAll(['project']));
  editor.on('projects', () => renderAll(['project']));
  editor.on('time', () => renderAll(['clips']));
  onLangChange(() => renderAll());
  renderAll();
  return { renderAll };
}
