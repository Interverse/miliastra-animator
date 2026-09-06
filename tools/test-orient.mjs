// Whole-model orientation and per-clip Root Motion.   node tools/test-orient.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { createNode, worldTransforms, getNode } from '../js/scene/scene.js';
import { createClip, insertKey } from '../js/anim/clips.js';
import { evaluatePose, clipHasRootMotion, rootMotionNode } from '../js/anim/evaluate.js';
import { exportGia, exportPivot, rotateAboutPivot, buildExportPlan } from '../js/gia/gia-export.js';
import { parseGia, collectObjects } from '../js/gia/gia-file.js';
import { FORWARDS, headingOf, headingName, yawBetween, yawQuat, modelForward, forwardFromSides } from '../js/anim/orient.js';
import { quat, v3, gameToDisplayPos } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const same = (a, b, eps = 1e-6) => v3.dist(a.pos, b.pos) < eps && quat.angle(a.rot, b.rot) < eps;
const pantalone = readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url));

// ---------- 1. headings ----------
{
  check('headings: +Z 0°, +X 90°, -Z 180°, -X -90°', headingOf(FORWARDS['+Z']) === 0 && headingOf(FORWARDS['+X']) === 90 && Math.abs(headingOf(FORWARDS['-Z'])) === 180 && headingOf(FORWARDS['-X']) === -90);
  check('yaw from +X to +Z is -90°, from -X +90°, from -Z 180°', yawBetween(90, 0) === -90 && yawBetween(-90, 0) === 90 && Math.abs(yawBetween(180, 0)) === 180);
  for (const [name, dir] of Object.entries(FORWARDS)) {
    const q = yawQuat(yawBetween(headingOf(dir), 0));
    check(`preset ${name} → +Z turns the forward vector onto +Z`, headingName(headingOf(quat.rotate(q, dir))) === '+Z');
  }
  check('forward from hips: left at +X, right at -X → faces +Z', forwardFromSides([0.1, 1, 0], [-0.1, 1, 0]).name === '+Z');
  check('forward from hips: left at -Z, right at +Z → faces +X', forwardFromSides([0, 1, -0.1], [0, 1, 0.1]).name === '+X');
}

// ---------- 2. a rigged model rotates as one assembly and the turn is frozen ----------
for (const [label, yaw] of [['+X → +Z', -90], ['-X → +Z', 90], ['-Z → +Z', 180], ['custom 45°', 45]]) {
  const ed = new Editor();
  ed.importGia(pantalone, 'Pantalone.gia');
  ed.applyAutoRig(ed.proposeAutoRig({ ik: true }));
  ed.addWaypath('manual');
  // an animation on a root bone (hips) and on a chain bone
  const hips = ed.project.nodes.find((n) => n.type === 'bone' && n.name === 'Hips');
  const neck = ed.project.nodes.find((n) => n.type === 'bone' && n.name === 'Neck');
  ed.createClip('walk');
  const clip = ed.project.clips[0];
  insertKey(clip, hips.id, 'pos', 0, hips.pos); insertKey(clip, hips.id, 'pos', 2, v3.add(hips.pos, [0, 0, 1])); // root motion along +Z
  insertKey(clip, neck.id, 'rot', 0, neck.rot, 'linear', [0, 0, 0]); insertKey(clip, neck.id, 'rot', 1, quat.fromEulerDeg([0, 40, 0]), 'linear', [0, 40, 0]);
  ed.history.reset(ed.snapshotState());
  const before = JSON.stringify(ed.snapshotState());
  const R = yawQuat(yaw), pivot = exportPivot(ed.project);
  const rest0 = evaluatePose(ed.project, null, 0).world;
  const anim0 = [0, 0.5, 1, 1.5, 2].map((t) => evaluatePose(ed.project, clip.id, t).world);
  const hipsLocal0 = ed.currentLocal(hips.id);
  const fwd0 = modelForward(ed.project);
  const ok = ed.reorientModel(R);
  const rest1 = evaluatePose(ed.project, null, 0).world;
  const allRotated = ed.project.nodes.every((n) => same(rest1.get(n.id), rotateAboutPivot(rest0.get(n.id), R, pivot), 1e-5));
  check(`${label}: every object, bone, IK target and pole is the old pose turned by ${yaw}° about the pivot`, ok && allRotated);
  const spacingOk = ed.project.nodes.every((a) => ed.project.nodes.every((b) => Math.abs(v3.dist(rest1.get(a.id).pos, rest1.get(b.id).pos) - v3.dist(rest0.get(a.id).pos, rest0.get(b.id).pos)) < 1e-6));
  check(`${label}: internal spacing unchanged, hierarchy and constraints intact`, spacingOk && ed.project.constraints.length > 0 && ed.project.nodes.filter((n) => n.parent).every((n) => getNode(ed.project, n.parent)));
  check(`${label}: root bone editable rotation unchanged (turn frozen into its basis)`, quat.angle(ed.currentLocal(hips.id).rot, hipsLocal0.rot) < 1e-9 && Math.abs(quat.toEulerDeg(getNode(ed.project, hips.id).basis.rot)[1] - yaw) < 1e-6 || (Math.abs(yaw) === 180 && Math.abs(Math.abs(quat.toEulerDeg(getNode(ed.project, hips.id).basis.rot)[1]) - 180) < 1e-6));
  const animOk = [0, 0.5, 1, 1.5, 2].every((t, i) => ed.project.nodes.every((n) => same(evaluatePose(ed.project, clip.id, t).world.get(n.id), rotateAboutPivot(anim0[i].get(n.id), R, pivot), 1e-5)));
  check(`${label}: the animation is the old animation turned with the model (root motion turns too)`, animOk);
  if (fwd0) check(`${label}: detected forward turned accordingly`, headingName(modelForward(ed.project).heading) === headingName(fwd0.heading + yaw));
  check(`${label}: waypath points turned`, v3.dist(ed.project.waypaths[0].points[1], quat.rotate(R, [0, 0, 2])) < 1e-9);
  // export applies the correction exactly once: placement == rotated rest pose
  ed.project.exportConfig.slots = [{ clipId: clip.id, name: 'walk', outputYaw: 0 }];
  const out = collectObjects(parseGia(exportGia(ed.project, ed.giaBytes).bytes));
  const placeOk = ed.project.nodes.filter((n) => n.type === 'object' && n.guid != null).every((n) => { const o = out.find((x) => x.guid === n.guid); return o && v3.dist(gameToDisplayPos(o.transform.position), rest1.get(n.id).pos) < 1e-4; });
  check(`${label}: exported placement is the reoriented pose (no double rotation)`, placeOk);
  check(`${label}: one undo step restores the exact previous project`, (ed.undo(), JSON.stringify(ed.snapshotState()) === before));
  ed.redo();
  check(`${label}: redo reproduces it`, ed.project.nodes.every((n) => same(evaluatePose(ed.project, null, 0).world.get(n.id), rest1.get(n.id), 1e-6)));
}

// ---------- 3. Root Motion per clip ----------
{
  const ed = new Editor();
  ed.importGia(readFileSync(new URL('./fixtures/White Square.gia', import.meta.url)), 'White Square.gia');
  ed.project.exportConfig.slots = [];
  const obj = ed.project.nodes.find((n) => n.type === 'object');
  const root = createNode(ed.project, 'bone', { name: 'Locomotion', pos: [0, 0, 0], length: 0.3 });
  obj.parent = root.id;
  const walk = createClip(ed.project, 'Walk Forward', 2);
  insertKey(walk, root.id, 'pos', 0, [0, 0, 0]); insertKey(walk, root.id, 'pos', 1, [0, 0.2, 1]); insertKey(walk, root.id, 'pos', 2, [0, 0, 2]);
  const attack = createClip(ed.project, 'Attack', 1);
  insertKey(attack, root.id, 'rot', 0, [0, 0, 0, 1]); insertKey(attack, root.id, 'rot', 1, quat.fromEulerDeg([0, 30, 0]));
  ed.history.reset(ed.snapshotState());
  check('root motion detected on the walk clip only', clipHasRootMotion(ed.project, walk) && rootMotionNode(ed.project, walk) === root.id && !clipHasRootMotion(ed.project, attack));
  const at = (t) => evaluatePose(ed.project, walk.id, t).world.get(obj.id).pos;
  check('Root Motion on (default): the character travels 2 m', Math.abs(at(2)[2] - at(0)[2] - 2) < 1e-9);
  ed.setClipRootMotion(walk.id, false);
  check('Root Motion off: the same clip plays in place, vertical motion kept, keys untouched', Math.abs(at(2)[2] - at(0)[2]) < 1e-9 && Math.abs(at(1)[1] - at(0)[1] - 0.2) < 1e-9 && walk.tracks[root.id].pos[2].v[2] === 2);
  check('the setting is per clip (Attack unaffected) and undoable', attack.rootMotion === undefined && ed.history.undoLabel() === 'Root motion off');
  // export respects it
  ed.project.exportConfig.slots = [{ clipId: walk.id, name: 'Walk', outputYaw: 0 }];
  const planOff = buildExportPlan(ed.project, ed.giaBytes);
  // horizontal travel from the exported placement (rest) to the last path point
  const travel = (plan) => { const pts = plan.devices[0].points, r0 = plan.rest.get(obj.id).pos; return v3.dist([r0[0], 0, r0[2]], [pts.at(-1).pos[0], 0, pts.at(-1).pos[2]]); };
  check('export with Root Motion off: the path stays in place', travel(planOff) < 1e-6);
  ed.setClipRootMotion(walk.id, true);
  check('toggle back on: original motion returns (in preview and export)', Math.abs(at(2)[2] - at(0)[2] - 2) < 1e-9 && Math.abs(travel(buildExportPlan(ed.project, ed.giaBytes)) - 2) < 1e-6);
  ed.setClipRootMotion(walk.id, false);
  const json = JSON.parse(JSON.stringify(ed.project));
  const ed2 = new Editor(); ed2.newProject(); ed2.applyRecord({ id: 'p', name: 'p', project: json, giaBytes: null });
  check('the setting persists in saved projects', ed2.project.clips[0].rootMotion === false && ed2.project.clips[0].tracks[root.id].pos.length === 3);
  ed.undo(); ed.undo(); ed.undo();
  check('undo returns to the default (on)', ed.project.clips[0].rootMotion === undefined || ed.project.clips[0].rootMotion === true);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
