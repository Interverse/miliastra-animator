// "Preserve child world transforms" mode: moving and/or rotating a node must leave
// every descendant's world transform unchanged in the rest pose and in every keyed
// pose, must never create keyframes, and undo must restore the exact previous
// state.   node tools/test-reorient.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { createNode, worldTransforms, descendants, parentWorld } from '../js/scene/scene.js';
import { createClip, insertKey, track } from '../js/anim/clips.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { quat, v3, xf } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const same = (a, b, eps = 1e-6) => v3.dist(a.pos, b.pos) < eps && quat.angle(a.rot, b.rot) < eps;
const HIST = 'Transform (preserve children)';

const ed = new Editor();
const p = ed.project;
const root = createNode(p, 'bone', { name: 'root', pos: [0.3, 1, 0], rot: quat.fromEulerDeg([10, 20, 30]), length: 0.4 });
const mid = createNode(p, 'bone', { name: 'mid', parent: root.id, pos: [0, 0.4, 0], rot: quat.fromEulerDeg([0, 0, 25]), length: 0.3 });
const tip = createNode(p, 'bone', { name: 'tip', parent: mid.id, pos: [0, 0.3, 0.05], rot: quat.fromEulerDeg([15, 0, 0]), length: 0.2 });
const obj = createNode(p, 'object', { name: 'obj', parent: mid.id, pos: [0.1, 0.2, 0], rot: quat.fromEulerDeg([0, 45, 0]), guid: 1, zoom: [0.1, 0.1, 0.1] });
obj.correction = [0, 0, 90];
const deep = createNode(p, 'proxy', { name: 'deep', parent: tip.id, pos: [0, 0.2, 0] });
const clip = createClip(p, 'A', 2);
p.activeClipId = clip.id;
insertKey(clip, mid.id, 'rot', 0, mid.rot); insertKey(clip, mid.id, 'rot', 1, quat.fromEulerDeg([0, 30, 60]));
insertKey(clip, mid.id, 'pos', 1, [0.02, 0.45, -0.01]); // the edited bone itself has position keys too
insertKey(clip, obj.id, 'pos', 0, obj.pos); insertKey(clip, obj.id, 'pos', 1, [0.3, 0.1, -0.2]);
insertKey(clip, obj.id, 'rot', 1, quat.fromEulerDeg([20, 0, 0]));
insertKey(clip, tip.id, 'rot', 1, quat.fromEulerDeg([0, 0, -40]));
ed.history.reset(p);
const snapshot = JSON.stringify(p);
const keyCount = () => ed.project.clips.reduce((n, c) => n + Object.values(c.tracks).reduce((m, tr) => m + tr.pos.length + tr.rot.length, 0), 0);
const keys0 = keyCount();

const worldsAt = (t) => evaluatePose(ed.project, clip.id, t).world; // always the live project (undo swaps it)
const TIMES = [['rest (t=0)', 0], ['keyed pose (t=1)', 1], ['interpolated (t=0.5)', 0.5]];
const capture = () => Object.fromEntries(TIMES.map(([, t]) => [t, worldsAt(t)]));
const before = capture();
const beforeMidLocal = ed.currentLocal(mid.id);
const descOf = (id) => descendants(ed.project, id);
const descendantsFixed = (label, id, ref) => {
  for (const [name, t] of TIMES) {
    const w = worldsAt(t);
    check(`${label}: descendants unchanged at ${name}`, descOf(id).every((n) => same(w.get(n.id), ref[t].get(n.id))),
      descOf(id).map((n) => `${n.name}: ${v3.dist(w.get(n.id).pos, ref[t].get(n.id).pos).toExponential(1)}/${quat.angle(w.get(n.id).rot, ref[t].get(n.id).rot).toExponential(1)}`).join(' '));
  }
};

// ---------- 1. rotate only (the original behaviour) ----------
ed.rotateMode = 'preserve';
const target = quat.norm(quat.mul(beforeMidLocal.rot, quat.fromEulerDeg([0, 40, 0]))); // reorient mid by 40° about its local Y
ed.setNodeLocal(mid.id, { rot: target });
check('bone takes the new orientation', quat.angle(ed.currentLocal(mid.id).rot, target) < 1e-6);
descendantsFixed('rotate', mid.id, before);
for (const [name, t] of TIMES) check(`bone reoriented by 40° at ${name}`, Math.abs(quat.angle(worldsAt(t).get(mid.id).rot, before[t].get(mid.id).rot) - 40 * Math.PI / 180) < 1e-6);
check('correction untouched', obj.correction.join() === '0,0,90');
check('no keyframes were created', keyCount() === keys0);
check('one undo step', ed.history.undoStack.length === 1 && ed.history.undoLabel() === HIST, ed.history.undoLabel());
ed.undo();
check('undo restores exact state', JSON.stringify(ed.project) === snapshot);
ed.redo();
check('redo reproduces corrected state', quat.angle(ed.currentLocal(mid.id).rot, target) < 1e-6 && descOf(mid.id).every((n) => same(worldsAt(1).get(n.id), before[1].get(n.id))));
ed.undo();

// ---------- 2. move only (root has no keys of its own; its descendants are keyed) ----------
// Translating a node whose ROTATION is keyed cannot be compensated exactly at every
// frame (the descendants' offset depends on the node's rotation at each time); that
// case is detected and reported (section 6). Rotation edits are always exact.
const dPos = [0.12, -0.05, 0.03];
const rootLocal0 = ed.currentLocal(root.id);
const newPos = v3.add(rootLocal0.pos, dPos);
const target2 = quat.norm(quat.mul(rootLocal0.rot, quat.fromEulerDeg([0, 0, -30])));
ed.setNodeLocal(root.id, { pos: newPos });
check('bone takes the new position', v3.dist(ed.currentLocal(root.id).pos, newPos) < 1e-9);
descendantsFixed('move', root.id, before);
for (const [name, t] of TIMES) check(`bone moved by Δ at ${name}`, v3.dist(worldsAt(t).get(root.id).pos, v3.add(before[t].get(root.id).pos, dPos)) < 1e-6 && quat.angle(worldsAt(t).get(root.id).rot, before[t].get(root.id).rot) < 1e-6);
check('move: no keyframes created', keyCount() === keys0);
check('move: the direct child keys were rebased once (grandchildren need no change)', ed.lastRigEdit.rebasedKeys === 3 && ed.lastRigEdit.inexact.length === 0, JSON.stringify(ed.lastRigEdit));
check('move: one undo step with the rig-edit label', ed.history.undoStack.length === 1 && ed.history.undoLabel() === HIST);
const movedJson = JSON.stringify(ed.project);
ed.undo();
check('move: undo restores exact state', JSON.stringify(ed.project) === snapshot);
ed.redo();
check('move: redo reproduces the correction exactly', JSON.stringify(ed.project) === movedJson);
ed.undo();

// ---------- 3. move + rotate in one edit; deep chain (grandchildren, attached object, proxy) ----------
ed.setNodeLocal(root.id, { pos: newPos, rot: target2 });
check('move+rotate: bone takes both', v3.dist(ed.currentLocal(root.id).pos, newPos) < 1e-9 && quat.angle(ed.currentLocal(root.id).rot, target2) < 1e-6);
descendantsFixed('move+rotate', root.id, before);
check('move+rotate: single undo step', ed.history.undoStack.length === 1);
ed.undo();
check('move+rotate: undo exact', JSON.stringify(ed.project) === snapshot);

// ---------- 4. numeric editing == gizmo editing (world-space entry, as Local/World gizmo modes produce) ----------
ed.setNodeLocal(root.id, { pos: newPos, rot: target2 });
const viaLocal = JSON.stringify(ed.project);
ed.undo();
const pw0 = parentWorld(ed.project, root.parent, ed.pose().world);
ed.setNodeWorld(root.id, xf.compose(pw0, { pos: newPos, rot: target2 }));
check('gizmo (world) edit gives the same bone transform as numeric (local) edit', v3.dist(ed.currentLocal(root.id).pos, newPos) < 1e-9 && quat.angle(ed.currentLocal(root.id).rot, target2) < 1e-9);
check('gizmo edit leaves descendants fixed too', descOf(root.id).every((n) => same(worldsAt(0.5).get(n.id), before[0.5].get(n.id))));
check('gizmo and numeric edits produce the same descendant local transforms', descOf(root.id).every((n) => { const o = JSON.parse(viaLocal).nodes.find((x) => x.id === n.id); return v3.dist(o.pos, n.pos) < 1e-9 && quat.angle(o.rot, n.rot) < 1e-9; }));
ed.undo();
// a drag: many transient updates from one snapshot (world-space, like the Move gizmo), then one commit
ed.beginReorient([root.id]);
for (let i = 1; i <= 5; i++) ed.setNodeWorld(root.id, xf.compose(pw0, { pos: v3.add(rootLocal0.pos, v3.scale(dPos, i / 5)), rot: target2 }), { commit: false });
ed.setNodeLocal(root.id, { pos: newPos, rot: target2 }); // final update commits
check('drag (snapshot + transient updates) ends in the same state as a single edit', JSON.stringify(ed.project) === viaLocal);
check('drag is one undo step', ed.history.undoStack.length === 1);
ed.undo();
// rotating in place with a keyed child in the middle of a drag
ed.beginReorient([mid.id]);
for (let i = 1; i <= 3; i++) ed.setNodeLocal(mid.id, { rot: quat.mul(beforeMidLocal.rot, quat.fromEulerDeg([0, 10 * i, 0])) }, { commit: false });
ed.setNodeLocal(mid.id, { rot: target });
check('rotate drag: descendants fixed, one undo step', descOf(mid.id).every((n) => same(worldsAt(1).get(n.id), before[1].get(n.id))) && ed.history.undoStack.length === 1);
ed.undo();

// ---------- 5. multi-selection: parent and child both selected → descendants compensated once ----------
ed.beginReorient([root.id, mid.id]);
ed.applyReorient(root.id, { pos: newPos }); // the viewport skips selected descendants of a selected ancestor
ed.endReorient();
descendantsFixed('multi-select root move', root.id, before);
check('multi-select: one undo step', ed.history.undoStack.length === 1);
ed.undo();
check('multi-select: undo exact', JSON.stringify(ed.project) === snapshot);

// ---------- 6. the inexact case: moving a bone whose rotation is keyed ----------
check('moving a rotation-animated bone is flagged before the edit', ed.moveRebaseInexact(mid.id) && !ed.moveRebaseInexact(root.id));
ed.setNodeLocal(mid.id, { pos: v3.add(beforeMidLocal.pos, dPos) });
check('inexact move: reported after the edit', ed.lastRigEdit.inexact.length === 1, JSON.stringify(ed.lastRigEdit));
check('inexact move: descendants still exact at the current frame', descOf(mid.id).every((n) => same(worldsAt(0).get(n.id), before[0].get(n.id))));
check('inexact move: undo restores exact state', (ed.undo(), JSON.stringify(ed.project) === snapshot));
ed.setNodeLocal(mid.id, { rot: target });
check('rotating the same bone is exact and not flagged', ed.lastRigEdit.inexact.length === 0 && descOf(mid.id).every((n) => same(worldsAt(0.5).get(n.id), before[0.5].get(n.id))));
ed.undo();

// ---------- 7. normal mode still moves children ----------
ed.rotateMode = 'normal';
p.settings.autoKey = false;
ed.setNodeLocal(root.id, { rot: quat.mul(ed.currentLocal(root.id).rot, quat.fromEulerDeg([0, 40, 0])) });
check('normal mode moves children', !same(worldsAt(0).get(obj.id), before[0].get(obj.id)));
ed.undo();
ed.setNodeLocal(root.id, { pos: [0.5, 1.2, -0.1] });
check('normal mode moves children on translation', !same(worldsAt(0).get(obj.id), before[0].get(obj.id)));
ed.undo();

// ---------- 8. IK ----------
const ikT = createNode(ed.project, 'target', { name: 't', pos: [0.6, 1.9, 0.2] });
const pole = createNode(ed.project, 'pole', { name: 'pole', pos: [1, 1, 1] });
ed.project.constraints.push({ id: 'k1', name: 'IK', boneId: tip.id, targetId: ikT.id, poleId: pole.id, chainLength: 2, enabled: true, influence: 1, iterations: 12 });
ed.history.reset(ed.project);
const ikBefore = worldsAt(0.5).get(deep.id);
const ikTipBefore = worldsAt(0.5).get(tip.id).rot;
ed.rotateMode = 'preserve';
ed.setNodeLocal(tip.id, { rot: quat.mul(ed.currentLocal(tip.id).rot, quat.fromEulerDeg([25, 60, 10])) });
check('IK tip reorient keeps child fixed', same(worldsAt(0.5).get(deep.id), ikBefore), `${v3.dist(worldsAt(0.5).get(deep.id).pos, ikBefore.pos).toExponential(1)}`);
check('IK tip itself changed (twist survives IK)', quat.angle(worldsAt(0.5).get(tip.id).rot, ikTipBefore) > 1e-3);
check('IK involvement is reported', ed.lastRigEdit?.ik === true);
ed.undo();
// moving a bone whose descendant is an IK chain member: the target/pole (not descendants) never move, the user is told the chain is re-solved
const tPos = ikT.pos.slice(), polePos = pole.pos.slice();
ed.setNodeLocal(root.id, { pos: [0.5, 1.2, -0.1] });
check('IK target and pole outside the moved hierarchy are unchanged', v3.dist(ikT.pos, tPos) < 1e-12 && v3.dist(pole.pos, polePos) < 1e-12);
check('moving above an IK chain reports that the chain is re-solved', ed.lastRigEdit?.ik === true);
ed.undo();
ed.project.constraints.length = 0;
ed.history.reset(ed.project);
ed.setNodeLocal(root.id, { pos: [0.5, 1.2, -0.1] });
check('no IK notice without constraints', ed.lastRigEdit?.ik === false);
ed.undo();

// ---------- 9. Auto-Rig fix-up on a real model: nudge a generated bone, the pose is untouched ----------
{
  const ed2 = new Editor();
  ed2.importGia(readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url)), 'Pantalone.gia');
  ed2.applyAutoRig(ed2.proposeAutoRig({ ik: false }));
  const fore = ed2.project.nodes.find((n) => n.type === 'bone' && n.name === 'Forearm.L');
  const objs = ed2.project.nodes.filter((n) => n.type === 'object');
  const w0 = worldTransforms(ed2.project, null);
  const before2 = JSON.stringify(ed2.snapshotState());
  const solved0 = evaluatePose(ed2.project, null, 0).world; // with IK
  ed2.rotateMode = 'preserve';
  // the elbow was generated 3 cm too far out: pull it back and twist it slightly
  const l = ed2.currentLocal(fore.id);
  ed2.setNodeLocal(fore.id, { pos: v3.add(l.pos, [-0.03, 0.01, 0]), rot: quat.mul(l.rot, quat.fromEulerDeg([0, 8, 0])) });
  const w1 = worldTransforms(ed2.project, null);
  check('auto-rig fix: every model piece keeps its world transform', objs.every((o) => same(w0.get(o.id), w1.get(o.id), 1e-6)));
  check('auto-rig fix: descendant bones (hand) keep their world transform', descendants(ed2.project, fore.id).every((n) => same(w0.get(n.id), w1.get(n.id), 1e-6)));
  check('auto-rig fix: the bone itself moved', v3.dist(w0.get(fore.id).pos, w1.get(fore.id).pos) > 0.02);
  const solved1 = evaluatePose(ed2.project, null, 0).world;
  check('auto-rig fix: IK target outside the hierarchy untouched', ed2.project.nodes.filter((n) => n.type === 'target' || n.type === 'pole').every((n) => same(solved0.get(n.id), solved1.get(n.id))));
  check('auto-rig fix: single undo restores the generated rig exactly', (ed2.undo(), JSON.stringify(ed2.snapshotState()) === before2));
  ed2.redo();
  check('auto-rig fix: redo reproduces it', objs.every((o) => same(w0.get(o.id), worldTransforms(ed2.project, null).get(o.id), 1e-6)) && v3.dist(worldTransforms(ed2.project, null).get(fore.id).pos, w1.get(fore.id).pos) < 1e-9);
  // with IK: the chain is re-solved from the new rest transform (reported), the bone's own descendants stay fixed in the solved pose
  const ed3 = new Editor();
  ed3.importGia(readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url)), 'Pantalone.gia');
  ed3.applyAutoRig(ed3.proposeAutoRig({ ik: true }));
  const fore3 = ed3.project.nodes.find((n) => n.type === 'bone' && n.name === 'Forearm.L');
  const s0 = evaluatePose(ed3.project, null, 0).world;
  ed3.rotateMode = 'preserve';
  const l3 = ed3.currentLocal(fore3.id);
  ed3.setNodeLocal(fore3.id, { pos: v3.add(l3.pos, [-0.03, 0.01, 0]) });
  const s1 = evaluatePose(ed3.project, null, 0).world;
  check('auto-rig fix with IK: descendants of the bone keep their solved world pose', descendants(ed3.project, fore3.id).every((n) => same(s0.get(n.id), s1.get(n.id), 1e-6)));
  check('auto-rig fix with IK: IK targets and poles untouched, chain re-solve reported', ed3.project.nodes.filter((n) => n.type === 'target' || n.type === 'pole').every((n) => same(s0.get(n.id), s1.get(n.id))) && ed3.lastRigEdit.ik === true);
}

// ---------- 10. an animated rig stays visually equivalent after the rebase (dense sampling) ----------
{
  ed.rotateMode = 'preserve';
  const samples = [0, 0.1, 0.25, 0.4, 0.5, 0.75, 0.9, 1, 1.5];
  const ref = samples.map((t) => worldsAt(t));
  ed.setNodeLocal(root.id, { pos: newPos, rot: target2 });
  const ok = samples.every((t, i) => descOf(root.id).every((n) => same(worldsAt(t).get(n.id), ref[i].get(n.id))));
  check('animation rebased: descendants trace the same world motion at every sampled time', ok);
  check('rebase touched existing keys only', track(clip, mid.id).rot.length === 2 && track(clip, mid.id).pos.length === 1 && keyCount() === keys0);
  ed.undo();
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
