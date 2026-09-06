// Viewport ↔ state synchronisation: nothing may stay rendered once its state entity is
// deleted, undone, or replaced by a project switch, and nothing may be rendered twice.
// The real Viewport needs WebGL; this drives the real Editor through every lifecycle
// operation against a headless double that uses the same EntityRegistry, entity
// derivation and validator as js/viewport/viewport.js.   node tools/test-viewport-sync.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { EntityRegistry, viewportEntities, validateSceneModel, nodeSignature } from '../js/viewport/scene-model.js';
import { createNode } from '../js/scene/scene.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const pantalone = readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url));

// Headless stand-in for the viewport: same reconciliation contract, fake render records.
class FakeViewport {
  constructor(editor) {
    this.editor = editor;
    this.registry = new EntityRegistry();
    this.sceneChildren = new Set(); // "attached" render objects (what the user would see)
    this.created = 0; this.disposed = 0; this.resets = 0;
    this.pathPoints = [];
    this.gizmoIds = [];
    editor.on('project', (e) => { if (e?.phase === 'teardown') this.resetProject(); });
  }
  sync({ deferObjects = false } = {}) {
    let budget = deferObjects ? 2 : Infinity; // simulate the progressive build: at most 2 new objects per frame
    const stats = this.registry.reconcile(viewportEntities(this.editor.project), {
      create: (d) => { this.created++; const rec = { id: d.id, sig: d.sig, obj: { nodeId: d.id } }; this.sceneChildren.add(rec.obj); return rec; },
      update: (rec, d) => { rec.updated = true; rec.type = d.type; },
      dispose: (rec) => { this.disposed++; this.sceneChildren.delete(rec.obj); },
      defer: (d) => d.type === 'object' && --budget < 0,
    });
    this.building = stats.deferred > 0;
    // waypath points are rebuilt from state (no registry entries), like the real viewport
    this.pathPoints = this.editor.project.waypaths.flatMap((w) => w.kind === 'manual' ? w.points.map((p, i) => ({ wpId: w.id, index: i })) : []);
    this.gizmoIds = this.editor.active ? [this.editor.active] : [];
    return stats;
  }
  resetProject() {
    this.resets++;
    this.registry.clear((rec) => { this.disposed++; this.sceneChildren.delete(rec.obj); });
    this.pathPoints = [];
    this.gizmoIds = [];
  }
  validate() {
    return validateSceneModel({
      project: this.editor.project, registryIds: this.registry.ids(), attached: (id) => this.sceneChildren.has(this.registry.get(id).obj), building: this.building,
      rootChildCount: this.sceneChildren.size, gizmoIds: this.gizmoIds, selection: [...this.editor.selection], active: this.editor.active,
      pathPointWaypaths: this.pathPoints.map((p) => p.wpId), pathPointSel: this.editor.pathPointSel,
    });
  }
  visibleIds() { return [...this.sceneChildren].map((o) => o.nodeId).sort(); }
}
const stateIds = (ed) => ed.project.nodes.map((n) => n.id).sort();
const inSync = (vp) => { const v = vp.validate(); return v.ok && JSON.stringify(vp.visibleIds()) === JSON.stringify(stateIds(vp.editor)); };
const detail = (vp) => JSON.stringify({ issues: vp.validate().issues.slice(0, 4), visible: vp.visibleIds().length, state: stateIds(vp.editor).length });

// ---------- 0. the registry contract ----------
{
  const reg = new EntityRegistry();
  const log = [];
  const hooks = { create: (d) => (log.push('c' + d.id), { }), update: (r, d) => log.push('u' + d.id), dispose: (r) => log.push('d' + r.id) };
  reg.reconcile([{ id: 'a', sig: 'x' }, { id: 'b', sig: 'x' }], hooks);
  reg.reconcile([{ id: 'a', sig: 'y' }], hooks); // b gone, a changed signature
  check('registry: create, rebuild on signature change, dispose missing', log.join(' ') === 'ca ua cb ub da ca ua db' && reg.size === 1, log.join(' '));
  const st = reg.reconcile([{ id: 'a', sig: 'y' }, { id: 'c', sig: 'z' }], { ...hooks, defer: (d) => d.id === 'c' });
  check('registry: deferred entities are neither created nor counted live', st.deferred === 1 && !reg.has('c') && reg.has('a'));
  reg.clear(hooks.dispose);
  check('registry: clear disposes everything', reg.size === 0 && log[log.length - 1] === 'da');
  check('node signature covers structural props only', nodeSignature({ type: 'object', zoom: [1, 2, 3] }) === 'o|1,2,3' && nodeSignature({ type: 'bone' }) === 'b' && nodeSignature({ type: 'target' }) === 'target');
}

// ---------- 1. undo / redo of every entity kind ----------
{
  const ed = new Editor();
  const vp = new FakeViewport(ed);
  ed.importGia(pantalone, 'Pantalone.gia');
  vp.sync();
  check('import: every object rendered exactly once', inSync(vp), detail(vp));
  const n0 = vp.visibleIds().length;
  const undoRedo = (label, act) => {
    const before = vp.visibleIds().length;
    act();
    vp.sync();
    const added = vp.visibleIds().length - before;
    check(`${label}: rendered after the edit, in sync`, inSync(vp), detail(vp));
    ed.undo(); vp.sync();
    check(`${label}: undo removes every visual (${added} entities) and leaves no stale selection`, vp.visibleIds().length === before && inSync(vp) && [...ed.selection].every((id) => stateIds(ed).includes(id)), detail(vp));
    ed.redo(); vp.sync();
    check(`${label}: redo brings exactly one representation back`, vp.visibleIds().length === before + added && inSync(vp) && new Set(vp.visibleIds()).size === vp.visibleIds().length, detail(vp));
    ed.undo(); vp.sync();
  };
  undoRedo('create bone', () => ed.addNode('bone', { name: 'b1', pos: [0, 1, 0] }));
  const bone = ed.addNode('bone', { name: 'arm', pos: [0, 1, 0], length: 0.3 }); vp.sync();
  let kid = null;
  undoRedo('IK target (+ constraint)', () => { kid = ed.addConstraint(bone.id).id; });
  kid = ed.addConstraint(bone.id).id; vp.sync();
  undoRedo('pole target', () => ed.addPoleFor(kid));
  undoRedo('display primitive (proxy)', () => ed.addProxy('sphere'));
  undoRedo('waypath (derived visual, no entity)', () => ed.addWaypath('manual'));
  undoRedo('constraint removal', () => ed.removeConstraint(kid));
  undoRedo('Auto-Rig skeleton (many bones + IK)', () => ed.applyAutoRig(ed.proposeAutoRig({ ik: true })));
  undoRedo('delete objects', () => ed.deleteNodes(ed.project.nodes.filter((n) => n.type === 'object').slice(0, 5).map((n) => n.id)));
  // deleting the selected node: selection and gizmo binding go with it
  const px = ed.addProxy('box'); vp.sync();
  ed.select([px.id]);
  ed.deleteNodes([px.id]); vp.sync();
  check('deleting the selected node clears selection, gizmo and its visual', !ed.selection.size && !ed.active && !vp.visibleIds().includes(px.id) && inSync(vp), detail(vp));
  ed.undo(); vp.sync();
  check('undoing that delete restores the visual without restoring a stale selection', vp.visibleIds().includes(px.id) && inSync(vp));
  check('entity count returned to the baseline (objects + arm bone + IK target + proxy)', vp.visibleIds().length === n0 + 3, `${vp.visibleIds().length} vs ${n0 + 3}`);
}

// ---------- 2. undo after animation, at different playhead positions ----------
{
  const ed = new Editor();
  const vp = new FakeViewport(ed);
  ed.importGia(pantalone, 'Pantalone.gia');
  ed.applyAutoRig(ed.proposeAutoRig({ ik: true }));
  ed.createClip('walk');
  vp.sync();
  const bone = ed.project.nodes.find((n) => n.type === 'bone' && n.name === 'Forearm.R');
  const before = vp.visibleIds().length;
  const k = ed.addConstraint(bone.id);
  const target = ed.project.nodes.find((n) => n.id === k.targetId);
  ed.select([target.id]);
  ed.setTime(0.5); ed.insertKeyframe([target.id], ['pos']);
  ed.setTime(1.0); ed.setNodeLocal(target.id, { pos: [0.5, 1.5, 0.2] }); ed.insertKeyframe([target.id], ['pos']);
  vp.sync();
  check('IK control keyed at two times is rendered once', inSync(vp) && vp.visibleIds().length === before + 1, detail(vp));
  for (const tm of [1.0, 0.25, 0]) {
    ed.setTime(tm);
    while (ed.history.undoStack.length && ed.project.nodes.some((n) => n.id === target.id)) ed.undo();
    vp.sync();
    check(`undo at t=${tm}: the IK target, its constraint and selection are gone`, !vp.visibleIds().includes(target.id) && !ed.project.constraints.some((c) => c.id === k.id) && !ed.selection.has(target.id) && inSync(vp), detail(vp));
    while (!ed.project.nodes.some((n) => n.id === target.id) && ed.history.redoStack?.length !== 0) { const n = vp.visibleIds().length; ed.redo(); vp.sync(); if (vp.visibleIds().length === n && ed.project.nodes.some((x) => x.id === target.id)) break; }
    vp.sync();
    check(`redo at t=${tm}: exactly one target visual`, vp.visibleIds().filter((id) => id === target.id).length === 1 && inSync(vp), detail(vp));
  }
}

// ---------- 3. New Project must fully clear the previous scene ----------
{
  const ed = new Editor();
  const vp = new FakeViewport(ed);
  ed.importGia(pantalone, 'Pantalone.gia');
  ed.applyAutoRig(ed.proposeAutoRig({ ik: true }));
  ed.addWaypath('manual');
  ed.select([ed.project.nodes.find((n) => n.type === 'target').id]);
  vp.sync();
  const oldIds = vp.visibleIds();
  check('rigged project rendered (bones, targets, poles, objects)', oldIds.length > 30 && inSync(vp));
  const r0 = vp.resets;
  ed.newProject(); vp.sync();
  check('New Project: teardown happened before the new state was shown', vp.resets === r0 + 1);
  check('New Project: nothing from the previous project remains', vp.visibleIds().length === 0 && vp.sceneChildren.size === 0 && vp.pathPoints.length === 0 && !ed.selection.size && !ed.active && inSync(vp), detail(vp));
  ed.importGia(readFileSync(new URL('./fixtures/White Square.gia', import.meta.url)), 'White Square.gia'); vp.sync();
  check('import after New Project: only the new project contents appear', inSync(vp) && vp.visibleIds().every((id) => stateIds(ed).includes(id)) && vp.resets === r0 + 2, detail(vp));
  // ids are reused across projects (n1, n2, …): the old n1 must never be shown for the new n1
  const reused = vp.visibleIds().filter((id) => oldIds.includes(id));
  check('reused ids map to fresh render entities (no reuse of old records)', reused.every((id) => vp.registry.get(id).type === ed.project.nodes.find((n) => n.id === id).type) && vp.created > oldIds.length);
}

// ---------- 4. project switching: no duplicates, no growth ----------
{
  const ed = new Editor();
  const vp = new FakeViewport(ed);
  ed.importGia(pantalone, 'Pantalone.gia');
  ed.applyAutoRig(ed.proposeAutoRig({ ik: true }));
  ed.addWaypath('manual');
  const recA = { id: 'A', name: 'A', project: JSON.parse(JSON.stringify(ed.project)), giaBytes: null, ui: ed.outlinerState?.() };
  ed.newProject();
  ed.importGia(readFileSync(new URL('./fixtures/White Square.gia', import.meta.url)), 'White Square.gia');
  ed.addNode('bone', { name: 'b', pos: [0, 0, 0] });
  const recB = { id: 'B', name: 'B', project: JSON.parse(JSON.stringify(ed.project)), giaBytes: null, ui: ed.outlinerState?.() };
  const counts = new Set();
  let ok = true;
  for (let i = 0; i < 12; i++) {
    const rec = i % 2 ? recB : recA;
    ed.applyRecord(JSON.parse(JSON.stringify(rec)));
    ed.select([ed.project.nodes[0].id]);
    vp.sync();
    if (!inSync(vp)) { ok = false; console.log('  switch', i, detail(vp)); }
    counts.add(`${rec.id}:${vp.visibleIds().length}`);
  }
  check('12 switches between two projects: always in sync, no bones/targets/paths from the other project', ok);
  check('viewport object count is identical every time a project is shown (no growth)', counts.size === 2, [...counts].join(' '));
  // open from a project file and recover an autosave use the same path
  const json = ed.projectFileJSON();
  ed.openProjectFile(json); vp.sync();
  check('Open project file: torn down and rebuilt in sync', inSync(vp) && vp.resets >= 14, detail(vp));
  ed.restoreSession({ projectId: 'S', projectName: 'S', project: recA.project, dirty: true }); vp.sync();
  check('Recover session: torn down and rebuilt in sync', inSync(vp), detail(vp));
}

// ---------- 5. progressive build never leaves entities behind or duplicates them ----------
{
  const ed = new Editor();
  const vp = new FakeViewport(ed);
  ed.importGia(pantalone, 'Pantalone.gia');
  let frames = 0;
  do { vp.sync({ deferObjects: true }); frames++; } while (vp.building && frames < 100);
  check('deferred construction converges to one entity per node', frames > 1 && inSync(vp), `${frames} frames ${detail(vp)}`);
  ed.newProject(); vp.sync({ deferObjects: true });
  check('New Project during/after a progressive build leaves nothing', vp.visibleIds().length === 0 && inSync(vp));
}

// ---------- 6. selection / preview / interaction cleanup on history restore ----------
{
  const ed = new Editor();
  const vp = new FakeViewport(ed);
  ed.importGia(pantalone, 'Pantalone.gia');
  const obj = ed.project.nodes.find((n) => n.type === 'object');
  ed.select([obj.id]); ed.setDisplayEdit?.(true);
  const bone = ed.addNode('bone', { name: 'b', pos: [0, 1, 0] });
  ed.select([bone.id]);
  ed.setRigPreview(ed.proposeAutoRig({ ik: false }));
  // an unfinished drag on the bone
  let finished = 0;
  ed.beginInteraction('gizmo-move', { finish: () => finished++, cancel: () => finished++ });
  ed.undo(); vp.sync();
  check('undo cancels the active interaction and clears previews', finished === 1 && ed.interactionKind === 'idle' && ed.rigPreview === null);
  check('undo drops the selection of the removed bone and its visual', !ed.selection.has(bone.id) && !vp.visibleIds().includes(bone.id) && inSync(vp), detail(vp));
  const wp = ed.addWaypath('manual');
  ed.selectPathPoint?.(wp.id, 0);
  ed.undo(); vp.sync();
  check('undoing a waypath clears its point selection and visuals', ed.pathPointSel === null && vp.pathPoints.length === 0 && inSync(vp));
  ed.beginInteraction('gizmo-rotate', { finish: () => finished++ });
  ed.newProject(); vp.sync();
  check('project switch cancels interactions before teardown', finished === 2 && ed.interactionKind === 'idle' && inSync(vp));
}

// ---------- 7. stress ----------
{
  const ed = new Editor();
  const vp = new FakeViewport(ed);
  const white = readFileSync(new URL('./fixtures/White Square.gia', import.meta.url));
  let ok = true, maxVisible = 0;
  for (let i = 0; i < 40; i++) {
    ed.importGia(i % 2 ? white : pantalone, 'x.gia'); vp.sync();
    ed.applyAutoRig(ed.proposeAutoRig({ ik: true })); vp.sync();
    ed.undo(); vp.sync(); ed.redo(); vp.sync();
    const objs = ed.project.nodes.filter((n) => n.type === 'object');
    ed.deleteNodes(objs.slice(0, 2).map((n) => n.id)); vp.sync();
    if (!inSync(vp)) { ok = false; console.log('  cycle', i, detail(vp)); }
    maxVisible = Math.max(maxVisible, vp.visibleIds().length);
    ed.newProject(); vp.sync();
    if (vp.visibleIds().length !== 0) ok = false;
  }
  check('40 import / rig / undo / redo / delete / new-project cycles stay in sync', ok);
  check('every created render entity was disposed (no leak)', vp.created === vp.disposed && vp.sceneChildren.size === 0, `${vp.created} created / ${vp.disposed} disposed`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
