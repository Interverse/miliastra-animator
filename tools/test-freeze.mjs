// Freeze Transform: the bone stays visually where it is, its current transform becomes the
// new rest basis, local values read 0 / identity, descendants and objects do not move, keys
// are rebased exactly, IK stays stable, and it is one undo step.   node tools/test-freeze.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { createNode, worldTransforms, descendants, getNode } from '../js/scene/scene.js';
import { createClip, insertKey } from '../js/anim/clips.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { quat, v3, xf } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const same = (a, b, eps = 1e-6) => v3.dist(a.pos, b.pos) < eps && quat.angle(a.rot, b.rot) < eps;
const deg = (q) => quat.toEulerDeg(q).map((v) => +v.toFixed(4));
const isZero = (l) => v3.len(l.pos) < 1e-9 && quat.angle(l.rot, [0, 0, 0, 1]) < 1e-9;
// undo/redo swap the project object: always read through the live editor
let ed;
const W = () => worldTransforms(ed.project, null);
const N = (id) => getNode(ed.project, id);
const D = (id) => descendants(ed.project, id);

// ---------- 1. chain Shoulder → Upper Arm → Forearm → Hand with an object on the forearm ----------
{
  ed = new Editor();
  const p = ed.project;
  const shoulder = createNode(p, 'bone', { name: 'Shoulder', pos: [0, 1.4, 0], rot: quat.fromEulerDeg([0, 0, -10]), length: 0.15 });
  const upper = createNode(p, 'bone', { name: 'Upper Arm', parent: shoulder.id, pos: [0, 0.15, 0], rot: quat.fromEulerDeg([0, 0, -80]), length: 0.3 });
  const fore = createNode(p, 'bone', { name: 'Forearm', parent: upper.id, pos: [0, 0.3, 0], rot: quat.fromEulerDeg([0, 0, 90]), length: 0.25 });
  const hand = createNode(p, 'bone', { name: 'Hand', parent: fore.id, pos: [0, 0.25, 0], rot: quat.fromEulerDeg([10, 0, 0]), length: 0.1 });
  const obj = createNode(p, 'object', { name: 'sleeve', parent: fore.id, pos: [0.02, 0.1, 0], rot: quat.fromEulerDeg([0, 30, 0]), guid: 1, zoom: [0.1, 0.1, 0.1] });
  obj.correction = [0, 0, 15];
  ed.history.reset(ed.snapshotState());
  const before = JSON.stringify(ed.snapshotState());
  const w0 = W();
  check('fixture: forearm shows rotation (0, 0, 90)', deg(ed.currentLocal(fore.id).rot).join() === '0,0,90');

  // Freeze rotation
  const r = ed.freezeTransform(fore.id, { pos: false, rot: true });
  const w1 = W();
  check('freeze rotation: forearm world transform identical', same(w0.get(fore.id), w1.get(fore.id), 1e-9));
  check('freeze rotation: local rotation now reads (0, 0, 0), position unchanged', deg(ed.currentLocal(fore.id).rot).join() === '0,0,0' && v3.dist(ed.currentLocal(fore.id).pos, [0, 0.3, 0]) < 1e-9);
  check('freeze rotation: hand, object (with correction) and every descendant did not move', D(fore.id).every((n) => same(w0.get(n.id), w1.get(n.id), 1e-9)));
  check('freeze rotation: ancestors untouched', same(w0.get(upper.id), w1.get(upper.id), 1e-12) && same(w0.get(shoulder.id), w1.get(shoulder.id), 1e-12));
  check('freeze rotation: basis stores the old rotation', N(fore.id).basis && deg(N(fore.id).basis.rot).join() === '0,0,90' && v3.len(N(fore.id).basis.pos) < 1e-12);
  check('freeze is one undo step', ed.history.undoStack.length === 1 && ed.history.undoLabel() === 'Freeze rotation' && r.rebased === 0);
  // future rotations happen relative to the corrected basis: +30° about local Z now turns from the frozen orientation
  ed.setNodeLocal(fore.id, { rot: quat.fromEulerDeg([0, 0, 30]) });
  const w2 = W();
  check('a new local rotation of 30° turns the bone 30° from its frozen orientation', Math.abs(quat.angle(w2.get(fore.id).rot, w1.get(fore.id).rot) * 180 / Math.PI - 30) < 1e-6);
  ed.undo();
  check('undo the edit: back to the frozen pose', same(W().get(fore.id), w1.get(fore.id), 1e-9) && isZero({ pos: [0, 0, 0], rot: ed.currentLocal(fore.id).rot }));
  ed.undo();
  check('undo the freeze: exact previous state (basis gone, values restored)', JSON.stringify(ed.snapshotState()) === before && !N(fore.id).basis);
  ed.redo();
  check('redo reproduces the frozen state exactly', deg(ed.currentLocal(fore.id).rot).join() === '0,0,0' && same(W().get(hand.id), w0.get(hand.id), 1e-9) && deg(N(fore.id).basis.rot).join() === '0,0,90');
  ed.undo();

  // Freeze position
  ed.setNodeLocal(fore.id, { pos: [2.4, -1.0, 0.7] });
  const wp0 = W();
  ed.freezeTransform(fore.id, { pos: true, rot: false });
  const wp1 = W();
  check('freeze position: same world position, local position reads (0, 0, 0)', same(wp0.get(fore.id), wp1.get(fore.id), 1e-9) && v3.len(ed.currentLocal(fore.id).pos) < 1e-12 && deg(ed.currentLocal(fore.id).rot).join() === '0,0,90');
  check('freeze position: descendants fixed', D(fore.id).every((n) => same(wp0.get(n.id), wp1.get(n.id), 1e-9)));
  ed.undo(); ed.undo();

  // Freeze both on the middle bone, then reset returns to the frozen rest
  ed.freezeTransform(fore.id, { pos: true, rot: true });
  const wb = W();
  check('freeze position & rotation: local values are all zero, pose unchanged', isZero(ed.currentLocal(fore.id)) && same(wb.get(fore.id), w0.get(fore.id), 1e-9) && D(fore.id).every((n) => same(w0.get(n.id), wb.get(n.id), 1e-9)));
  ed.setNodeLocal(fore.id, { pos: [0.1, 0, 0], rot: quat.fromEulerDeg([0, 40, 0]) });
  ed.resetTransform(fore.id);
  check('Reset after freezing returns to the frozen rest (the original pose)', same(W().get(fore.id), w0.get(fore.id), 1e-9));
  // Freeze on top of an existing basis composes exactly
  ed.setNodeLocal(fore.id, { rot: quat.fromEulerDeg([0, 0, 20]) });
  const wc0 = W();
  ed.freezeTransform(fore.id, { pos: false, rot: true });
  check('freezing again composes the basis (no drift)', same(W().get(fore.id), wc0.get(fore.id), 1e-9) && deg(N(fore.id).basis.rot).join() === '0,0,110' && isZero(ed.currentLocal(fore.id)));
  // Unfreeze folds the basis back into the local values
  const wu0 = W();
  ed.unfreezeTransform(fore.id);
  check('unfreeze: basis removed, local values show the accumulated rest, pose unchanged', !N(fore.id).basis && deg(ed.currentLocal(fore.id).rot).join() === '0,0,110' && same(W().get(fore.id), wu0.get(fore.id), 1e-9) && D(fore.id).every((n) => same(wu0.get(n.id), W().get(n.id), 1e-9)));
  // Preserve child world transforms still works on a frozen bone
  ed.freezeTransform(fore.id, { pos: true, rot: true });
  ed.rotateMode = 'preserve';
  const wr0 = W();
  ed.setNodeLocal(fore.id, { rot: quat.fromEulerDeg([0, 25, 0]), pos: [0.05, 0, 0] });
  const wr1 = W();
  check('preserve-children edit on a frozen bone: descendants fixed, bone moved', D(fore.id).every((n) => same(wr0.get(n.id), wr1.get(n.id), 1e-6)) && !same(wr0.get(fore.id), wr1.get(fore.id)));
  ed.rotateMode = 'normal';
  // world-space edits (gizmo path) strip the basis correctly
  ed.undo();
  const wcur = W().get(fore.id); // the frozen rest (all rotations in this chain are about Z, so local Z ≡ world Z)
  const want = quat.mul(quat.fromEulerDeg([0, 0, 15]), wcur.rot);
  ed.setNodeWorld(fore.id, { pos: wcur.pos, rot: want });
  check('gizmo (world) edit on a frozen bone yields local = 15° about Z and the requested world pose', Math.abs(deg(ed.currentLocal(fore.id).rot)[2] - 15) < 1e-6 && quat.angle(W().get(fore.id).rot, want) < 1e-9);
  void xf;
}

// ---------- 2. animation is rebased exactly ----------
{
  ed = new Editor();
  const p = ed.project;
  const root = createNode(p, 'bone', { name: 'root', pos: [0, 1, 0], rot: quat.fromEulerDeg([0, 20, 0]), length: 0.3 });
  const mid = createNode(p, 'bone', { name: 'mid', parent: root.id, pos: [0, 0.3, 0], rot: quat.fromEulerDeg([0, 0, 90]), length: 0.3 });
  const tip = createNode(p, 'bone', { name: 'tip', parent: mid.id, pos: [0, 0.3, 0], rot: quat.fromEulerDeg([15, 0, 0]), length: 0.2 });
  const obj = createNode(p, 'object', { name: 'o', parent: tip.id, pos: [0, 0.1, 0], guid: 1, zoom: [0.1, 0.1, 0.1] });
  const clip = createClip(p, 'A', 2); p.activeClipId = clip.id;
  insertKey(clip, mid.id, 'rot', 0, mid.rot); insertKey(clip, mid.id, 'rot', 1, quat.fromEulerDeg([30, 0, 60])); insertKey(clip, mid.id, 'rot', 2, quat.fromEulerDeg([0, 45, 90]));
  insertKey(clip, mid.id, 'pos', 0.5, [0.1, 0.3, 0]); insertKey(clip, mid.id, 'pos', 1.5, [-0.1, 0.35, 0.05]);
  insertKey(clip, tip.id, 'rot', 1, quat.fromEulerDeg([0, 0, -40]));
  ed.history.reset(ed.snapshotState());
  const before = JSON.stringify(ed.snapshotState());
  const times = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const ref = times.map((t) => evaluatePose(ed.project, clip.id, t).world);
  ed.setTime(0);
  const r = ed.freezeTransform(mid.id, { pos: true, rot: true });
  check('animated bone: freeze rebased every key of the bone', r.rebased === 5);
  const ok = times.every((t, i) => [mid, tip, obj].every((n) => same(evaluatePose(ed.project, clip.id, t).world.get(n.id), ref[i].get(n.id), 1e-6)));
  check('animated bone: the whole animation is visually identical at every sampled time', ok);
  check('animated bone: at the freeze time the local values read zero', isZero(ed.currentLocal(mid.id)));
  ed.setTime(1.5);
  check('at another frame the local value is the pose relative to the new rest (not zero)', !isZero(ed.currentLocal(mid.id)));
  ed.undo();
  check('undo restores keys, basis and values exactly', JSON.stringify(ed.snapshotState()) === before);
  // Auto Key must not fire for a freeze (no new keys)
  ed.project.settings.autoKey = true;
  const keys0 = ed.project.clips[0].tracks[mid.id].rot.length + ed.project.clips[0].tracks[mid.id].pos.length;
  ed.setTime(0.75);
  ed.freezeTransform(mid.id, { pos: false, rot: true });
  check('freeze with Auto Key on creates no keyframes', ed.project.clips[0].tracks[mid.id].rot.length + ed.project.clips[0].tracks[mid.id].pos.length === keys0);
  ed.undo();
  // unkeyed pose edit (override) is rebased too
  ed.project.settings.autoKey = false;
  ed.setTime(0.5);
  ed.setNodeLocal(mid.id, { rot: quat.fromEulerDeg([0, 0, 120]) }); // override (no key at 0.5 for rot)
  const wo = evaluatePose(ed.project, clip.id, 0.5, { overrides: ed.activeOverrides() }).world.get(tip.id);
  ed.freezeTransform(mid.id, { pos: false, rot: true });
  check('an unkeyed pose edit is rebased: pose unchanged, local reads zero', same(evaluatePose(ed.project, clip.id, 0.5, { overrides: ed.activeOverrides() }).world.get(tip.id), wo, 1e-6) && isZero({ pos: [0, 0, 0], rot: ed.currentLocal(mid.id).rot }));
}

// ---------- 3. IK chains stay stable ----------
{
  ed = new Editor();
  ed.importGia(readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url)), 'Pantalone.gia');
  ed.applyAutoRig(ed.proposeAutoRig({ ik: true }));
  const fore = ed.project.nodes.find((n) => n.type === 'bone' && n.name === 'Forearm.L');
  const upper = ed.project.nodes.find((n) => n.type === 'bone' && n.name === 'Upper Arm.L');
  const s0 = evaluatePose(ed.project, null, 0).world;
  const objs = ed.project.nodes.filter((n) => n.type === 'object');
  const r = ed.freezeTransform(fore.id, { pos: true, rot: true });
  const s1 = evaluatePose(ed.project, null, 0).world;
  check('IK chain member frozen: the solved pose of every bone and object is unchanged', [...ed.project.nodes].every((n) => same(s0.get(n.id), s1.get(n.id), 1e-6)) && r.ik === true);
  check('frozen IK bone reads zero locally', isZero(ed.currentLocal(fore.id)));
  // move the IK target: the chain still solves smoothly from the new basis (no snap)
  const target = ed.project.nodes.find((n) => n.type === 'target' && ed.project.constraints.some((k) => k.targetId === n.id && (k.boneId === fore.id || k.boneId === upper.id)));
  if (target) {
    const tw = s1.get(target.id).pos;
    ed.setNodeLocal(target.id, { pos: v3.add(ed.currentLocal(target.id).pos, [0.02, 0.02, 0]) });
    const s2 = evaluatePose(ed.project, null, 0).world;
    const moved = v3.dist(s2.get(fore.id).pos, s1.get(fore.id).pos) + quat.angle(s2.get(fore.id).rot, s1.get(fore.id).rot);
    check('after freezing, a small IK target move produces a small chain change (no snapping)', moved > 1e-6 && moved < 0.2, `${moved.toFixed(4)}`);
    void tw;
  }
  ed.undo(); if (target) ed.undo();
  check('undo restores the rig exactly (solved pose within IK solver precision)', [...ed.project.nodes].every((n) => same(s0.get(n.id), evaluatePose(ed.project, null, 0).world.get(n.id), 1e-6)) && !N(fore.id).basis);
  // export is unaffected by a basis (objects only see world transforms)
  ed.freezeTransform(upper.id, { pos: true, rot: true });
  const { exportGia } = await import('../js/gia/gia-export.js');
  const { parseGia, collectObjects } = await import('../js/gia/gia-file.js');
  ed.project.exportConfig.slots = [];
  const out1 = collectObjects(parseGia(exportGia(ed.project, ed.giaBytes).bytes));
  ed.undo();
  const out0 = collectObjects(parseGia(exportGia(ed.project, ed.giaBytes).bytes));
  check('export placement identical with and without a frozen basis', JSON.stringify(out0.map((o) => o.transform)) === JSON.stringify(out1.map((o) => o.transform)));
}

// ---------- 4. frozen channels read exactly (0, 0, 0) ----------
{
  const starts = [[0, 0, 90], [0, 0, -90], [180, 0, 0], [360, 0, 0], [0, 360, 0], [0, 0, 360], [29.38, 90, -45], [359.999999, 0, 0.0000004], [-0.000001, 360.000001, 720]];
  for (const e0 of starts) {
    ed = new Editor();
    const p = ed.project;
    const root = createNode(p, 'bone', { name: 'root', pos: [0, 1, 0], rot: quat.fromEulerDeg([0, 20, 0]), length: 0.3 });
    const bone = createNode(p, 'bone', { name: 'b', parent: root.id, pos: [0, 0.3, 0], length: 0.3 });
    const child = createNode(p, 'bone', { name: 'c', parent: bone.id, pos: [0, 0.3, 0], rot: quat.fromEulerDeg([15, 0, 0]), length: 0.2 });
    const obj = createNode(p, 'object', { name: 'o', parent: bone.id, pos: [0.1, 0.1, 0], guid: 1, zoom: [0.1, 0.1, 0.1] });
    ed.history.reset(ed.snapshotState());
    ed.setNodeLocal(bone.id, { rot: quat.fromEulerDeg(e0), rotE: e0 });
    const shown = ed.currentLocal(bone.id).rotE;
    const w0 = W();
    const beforeFreeze = JSON.stringify(ed.snapshotState());
    ed.freezeTransform(bone.id, { pos: false, rot: true });
    const e1 = ed.currentLocal(bone.id).rotE;
    const w1 = W();
    check(`freeze (${e0.join(', ')}) → channels read exactly 0, 0, 0`, e1.length === 3 && e1.every((v) => v === 0 && !Object.is(v, -0)), `${shown.join(', ')} → ${e1.join(', ')}`);
    check(`freeze (${e0.join(', ')}) → bone, child and object visually unchanged`, same(w0.get(bone.id), w1.get(bone.id), 1e-6) && same(w0.get(child.id), w1.get(child.id), 1e-6) && same(w0.get(obj.id), w1.get(obj.id), 1e-6));
    // save / reopen keeps zeros; undo restores the exact authored values; redo returns to zeros
    const json = JSON.parse(JSON.stringify(ed.project));
    const ed2 = new Editor(); ed2.newProject(); ed2.applyRecord({ id: 'x', name: 'x', project: json, giaBytes: null });
    check(`freeze (${e0.join(', ')}) → reopened project still shows zeros`, ed2.currentLocal(bone.id).rotE.every((v) => v === 0));
    ed.undo();
    check(`freeze (${e0.join(', ')}) → undo restores the exact previous values`, JSON.stringify(ed.snapshotState()) === beforeFreeze && ed.currentLocal(bone.id).rotE.join() === shown.join());
    ed.redo();
    check(`freeze (${e0.join(', ')}) → redo returns to exact zeros`, ed.currentLocal(bone.id).rotE.every((v) => v === 0));
  }
  // multi-turn animation survives a freeze: a 0→360→720 spin frozen at t=1 (360°) becomes -360→0→360
  ed = new Editor();
  const p = ed.project;
  const bone = createNode(p, 'bone', { name: 'spin', pos: [0, 1, 0], length: 0.3 });
  ed.createClip('spin');
  const clip = ed.project.clips[0];
  insertKey(clip, bone.id, 'rot', 0, quat.fromEulerDeg([0, 0, 0]), 'linear', [0, 0, 0]);
  insertKey(clip, bone.id, 'rot', 1, quat.fromEulerDeg([0, 360, 0]), 'linear', [0, 360, 0]);
  insertKey(clip, bone.id, 'rot', 2, quat.fromEulerDeg([0, 720, 0]), 'linear', [0, 720, 0]);
  ed.history.reset(ed.snapshotState());
  const rotAt = (t) => evaluatePose(ed.project, clip.id, t).world.get(bone.id).rot;
  const mid0 = rotAt(0.5), mid1 = rotAt(1.5), q25 = rotAt(0.25);
  ed.setTime(1);
  ed.freezeTransform(bone.id, { pos: false, rot: true });
  const keysE = ed.project.clips[0].tracks[bone.id].rot.map((k) => k.e[1]);
  check('freezing at 360° keeps the authored turns relative to the new zero: keys -360, 0, 360', keysE.join() === '-360,0,360' && ed.currentLocal(bone.id).rotE.every((v) => v === 0), keysE.join());
  check('the spin still plays two full turns (world orientation at t=0.25 / 0.5 / 1.5 unchanged)', quat.angle(rotAt(0.5), mid0) < 1e-6 && quat.angle(rotAt(1.5), mid1) < 1e-6 && quat.angle(rotAt(0.25), q25) < 1e-6 && Math.abs(quat.toEulerDeg(rotAt(0.25))[1] - 90) < 1e-6);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
