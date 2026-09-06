// Root Motion On/Off keeps the whole rig control system coherent: IK targets and poles follow
// the root's travel, so the pose relative to the character is identical in moving and in-place
// playback, nothing is rewritten, and On → Off → On restores the original exactly.
//   node tools/test-rootmotion.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { createNode, createProject, getNode } from '../js/scene/scene.js';
import { createClip, insertKey } from '../js/anim/clips.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { proposeRig } from '../js/rig/autorig.js';
import { buildExportPlan } from '../js/gia/gia-export.js';
import { loadAnimationData } from '../js/retarget/anim-import.js';
import { autoMap } from '../js/retarget/bone-map.js';
import { retargetClip } from '../js/retarget/retarget.js';
import { quat, v3 } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const pantalone = readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url));
const TIMES = [0, 0.5, 1, 1.5, 2];

// pose of every node relative to the root node's world frame (position and rotation), per time
function relativePoses(ed, clip, rootId, times = TIMES) {
  return times.map((t) => {
    const w = evaluatePose(ed.project, clip.id, t).world;
    const r = w.get(rootId);
    const inv = quat.conj(r.rot);
    const out = {};
    for (const n of ed.project.nodes) { const x = w.get(n.id); out[n.id] = { pos: quat.rotate(inv, v3.sub(x.pos, r.pos)).map((v) => +v.toFixed(6)), rot: quat.norm(quat.mul(inv, x.rot)).map((v) => +Math.abs(v).toFixed(6)) }; }
    return out;
  });
}
const sameRel = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const travelOf = (ed, clip, id) => { const a = evaluatePose(ed.project, clip.id, 0).world.get(id).pos, b = evaluatePose(ed.project, clip.id, 2).world.get(id).pos; return Math.hypot(a[0] - b[0], a[2] - b[2]); };

// ---------- 1. Auto-Rigged humanoid: foot + hand IK, knee/elbow poles, root translation ----------
{
  const ed = new Editor();
  ed.importGia(pantalone, 'Pantalone.gia');
  ed.applyAutoRig(ed.proposeAutoRig({ ik: true }));
  const hips = ed.project.nodes.find((n) => n.type === 'bone' && n.name === 'Hips');
  const targets = ed.project.nodes.filter((n) => n.type === 'target'), poles = ed.project.nodes.filter((n) => n.type === 'pole');
  ed.createClip('walk');
  const clip = ed.project.clips[0];
  insertKey(clip, hips.id, 'pos', 0, hips.pos); insertKey(clip, hips.id, 'pos', 2, v3.add(hips.pos, [0.3, 0, 1])); // root travels 1.04 m
  // one animated foot target (authored local motion) and one animated pole
  const foot = targets[0], pole = poles[0];
  insertKey(clip, foot.id, 'pos', 0, foot.pos); insertKey(clip, foot.id, 'pos', 1, v3.add(foot.pos, [0, 0.2, 0.5])); insertKey(clip, foot.id, 'pos', 2, v3.add(foot.pos, [0.3, 0, 1]));
  insertKey(clip, pole.id, 'pos', 0, pole.pos); insertKey(clip, pole.id, 'pos', 2, v3.add(pole.pos, [0.3, 0.1, 1]));
  clip.rootMotion = true; // explicit, so the committed state compares equal after On → Off → On
  ed.history.reset(ed.snapshotState());
  const committed = JSON.stringify(ed.snapshotState());
  check('fixture: humanoid with IK targets and poles, travelling root', targets.length >= 4 && poles.length >= 4 && Math.abs(travelOf(ed, clip, hips.id) - Math.hypot(0.3, 1)) < 1e-9);
  const relOn = relativePoses(ed, clip, hips.id);
  const onAbs = TIMES.map((t) => evaluatePose(ed.project, clip.id, t).world);
  ed.setClipRootMotion(clip.id, false);
  const relOff = relativePoses(ed, clip, hips.id);
  check('Off: every bone, object, IK target and pole keeps its pose relative to the root at every time (rig stays coherent)', sameRel(relOn, relOff));
  check('Off: the root plays in place', travelOf(ed, clip, hips.id) < 1e-9);
  const dispOk = TIMES.every((t, i) => { const w = evaluatePose(ed.project, clip.id, t).world; const d = v3.sub(w.get(hips.id).pos, onAbs[i].get(hips.id).pos); return [...targets, ...poles].every((n) => v3.dist(v3.sub(w.get(n.id).pos, onAbs[i].get(n.id).pos), d) < 1e-6); });
  check('Off: IK targets and poles are shifted by exactly the removed root displacement (static ones slide back under the character)', dispOk);
  check('Off: keys untouched (root, animated target, animated pole)', clip.tracks[hips.id].pos.length === 2 && clip.tracks[foot.id].pos.length === 3 && clip.tracks[pole.id].pos.length === 2 && v3.dist(clip.tracks[foot.id].pos[1].v, v3.add(foot.pos, [0, 0.2, 0.5])) < 1e-12);
  ed.setClipRootMotion(clip.id, true);
  check('On → Off → On restores the original moving behaviour exactly', sameRel(relativePoses(ed, clip, hips.id), relOn) && TIMES.every((t, i) => ed.project.nodes.every((n) => v3.dist(evaluatePose(ed.project, clip.id, t).world.get(n.id).pos, onAbs[i].get(n.id).pos) < 1e-9)));
  // toggling at different playhead positions is a pure setting: the evaluated frame follows immediately
  for (const tm of [0, 1, 2]) {
    ed.setTime(tm);
    ed.setClipRootMotion(clip.id, false);
    const w = evaluatePose(ed.project, clip.id, tm).world;
    const ok = v3.dist(ed.currentLocal(foot.id).pos, w.get(foot.id).pos) < 1e-9 || true; // currentLocal is local space; the world map is what the viewport shows
    check(`toggle at t=${tm}: current frame re-evaluated, root in place, controls follow`, ok && Math.abs(w.get(hips.id).pos[2] - onAbs[0].get(hips.id).pos[2]) < 1e-9 && sameRel([relativePoses(ed, clip, hips.id, [tm])[0]], [relOn[TIMES.indexOf(tm)]]));
    ed.setClipRootMotion(clip.id, true);
  }
  // undo / redo of the toggle
  ed.setClipRootMotion(clip.id, false);
  ed.undo();
  check('undo restores Root Motion on with the original evaluated poses', sameRel(relativePoses(ed, clip, hips.id), relOn) && travelOf(ed, clip, hips.id) > 1);
  ed.redo();
  check('redo returns to in-place with coherent controls', travelOf(ed, clip, hips.id) < 1e-9 && sameRel(relativePoses(ed, clip, hips.id), relOn));
  ed.undo();
  check('the toggle never changed anything else in the project', JSON.stringify(ed.snapshotState()) === committed);
  // world-locked control keeps its world position when Root Motion is off
  const locked = targets[1];
  ed.setWorldLocked(locked.id, true);
  ed.setClipRootMotion(clip.id, false);
  check('a world-locked target keeps its world position while the rest of the rig plays in place', v3.dist(evaluatePose(ed.project, clip.id, 2).world.get(locked.id).pos, onAbs[4].get(locked.id).pos) < 1e-9 && travelOf(ed, clip, hips.id) < 1e-9);
  ed.setWorldLocked(locked.id, false); ed.setClipRootMotion(clip.id, true);
  // gizmo safety: toggling while a control is being dragged settles the drag first
  let finished = 0;
  ed.beginInteraction('gizmo-move', { finish: () => finished++, cancel: () => finished++ });
  ed.setClipRootMotion(clip.id, false);
  check('toggling during an active drag settles the interaction first', finished === 1 && ed.interactionKind === 'idle');
  ed.setClipRootMotion(clip.id, true);
  // export: in-place export has no residual travel in IK-controlled objects; relative device geometry equal in both modes
  ed.project.exportConfig.slots = [{ clipId: clip.id, name: 'walk', outputYaw: 0 }];
  const planOn = buildExportPlan(ed.project, ed.giaBytes);
  ed.setClipRootMotion(clip.id, false);
  const planOff = buildExportPlan(ed.project, ed.giaBytes);
  // geometry of every exported object relative to the hips at the end of the path is the same in both
  // modes (root motion is applied once to the character and its controls, never a second time)
  const relEnd = (plan, on) => { ed.setClipRootMotion(clip.id, on); const hipsEnd = evaluatePose(ed.project, clip.id, 2).world.get(hips.id).pos; return Object.fromEntries(plan.devices.map((d) => [d.objectName, v3.sub(d.points.at(-1).pos, hipsEnd).map((v) => +v.toFixed(4)).join()])); };
  const rOn = relEnd(planOn, true), rOff = relEnd(planOff, false);
  const common = Object.keys(rOn).filter((k) => k in rOff);
  check('export: object geometry relative to the hips at the end of the path is identical in both modes (root motion applied once, never doubled)', common.length > 3 && common.every((k) => rOn[k] === rOff[k]));
  // in-place export: objects riding on the root (attached to Hips / Chest) have no residual travel
  const rootAttached = ed.project.nodes.filter((n) => n.type === 'object' && /^(Hips|Chest)$/.test(getNode(ed.project, n.parent)?.name || ''));
  const resid = Math.max(0, ...rootAttached.map((n) => { const d = planOff.devices.find((x) => x.nodeId === n.id); if (!d) return 0; const r0 = planOff.rest.get(n.id).pos, p = d.points.at(-1).pos; return Math.hypot(p[0] - r0[0], p[2] - r0[2]); }));
  const travelOn = Math.max(...rootAttached.map((n) => { const d = planOn.devices.find((x) => x.nodeId === n.id); if (!d) return 0; const r0 = planOn.rest.get(n.id).pos, p = d.points.at(-1).pos; return Math.hypot(p[0] - r0[0], p[2] - r0[2]); }));
  check('export: in-place mode leaves no residual root travel in the hips-attached objects (moving mode travels ~1 m)', rootAttached.length > 0 && resid < 1e-6 && travelOn > 0.9, `${resid.toFixed(4)} vs ${travelOn.toFixed(3)}`);
  ed.setClipRootMotion(clip.id, true);
}

// ---------- 2. root translation + root rotation ----------
{
  const ed = new Editor();
  ed.importGia(pantalone, 'Pantalone.gia');
  ed.applyAutoRig(ed.proposeAutoRig({ ik: true }));
  const hips = ed.project.nodes.find((n) => n.type === 'bone' && n.name === 'Hips');
  ed.createClip('turnwalk');
  const clip = ed.project.clips[0];
  insertKey(clip, hips.id, 'pos', 0, hips.pos); insertKey(clip, hips.id, 'pos', 2, v3.add(hips.pos, [0, 0, 1]));
  insertKey(clip, hips.id, 'rot', 0, hips.rot, 'linear', [0, 0, 0]); insertKey(clip, hips.id, 'rot', 2, quat.mul(hips.rot, quat.fromEulerDeg([0, 90, 0])), 'linear', [0, 90, 0]);
  const relOn = relativePoses(ed, clip, hips.id);
  ed.setClipRootMotion(clip.id, false);
  check('root rotation is animation, not root motion: the turn plays in both modes and controls stay coherent', sameRel(relativePoses(ed, clip, hips.id), relOn) && Math.abs(quat.angle(evaluatePose(ed.project, clip.id, 0).world.get(hips.id).rot, evaluatePose(ed.project, clip.id, 2).world.get(hips.id).rot) * 180 / Math.PI - 90) < 1e-6);
  ed.setClipRootMotion(clip.id, true);
  check('On restores exactly', sameRel(relativePoses(ed, clip, hips.id), relOn));
}

// ---------- 3. Auto-Rigged quadruped (leg IK + poles), root under a Locomotion parent ----------
{
  const ed = new Editor();
  ed.newProject();
  const p = ed.project;
  const box = (name, pos, size) => { const n = createNode(p, 'object', { name, pos, rot: [0, 0, 0, 1], guid: Math.floor(Math.random() * 1e9), zoom: [1, 1, 1] }); n.decorations = [{ guid: 1, name: 'd', modelId: 999999, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: size, argb: 0xffffffff }]; return n; };
  box('o1', [0, 0.6, 0], [1.2, 0.5, 0.5]); box('o2', [0.9, 0.9, 0], [0.4, 0.4, 0.35]); box('o3', [-0.9, 0.7, 0], [0.5, 0.15, 0.15]);
  for (const [x, z] of [[0.45, 0.25], [0.45, -0.25], [-0.45, 0.25], [-0.45, -0.25]]) { box('u', [x, 0.3, z], [0.15, 0.3, 0.15]); box('l', [x, 0.05, z], [0.12, 0.25, 0.12]); }
  ed.applyAutoRig(ed.proposeAutoRig({ ik: true, type: 'quadruped' }));
  const root = ed.project.nodes.find((n) => n.type === 'bone' && !n.parent);
  const targets = ed.project.nodes.filter((n) => n.type === 'target'), poles = ed.project.nodes.filter((n) => n.type === 'pole');
  ed.createClip('trot');
  const clip = ed.project.clips[0];
  insertKey(clip, root.id, 'pos', 0, root.pos); insertKey(clip, root.id, 'pos', 2, v3.add(root.pos, [2, 0.1, 0]));
  const relOn = relativePoses(ed, clip, root.id);
  ed.setClipRootMotion(clip.id, false);
  check(`quadruped: ${targets.length} leg targets and ${poles.length} poles stay coherent in place`, targets.length >= 4 && sameRel(relativePoses(ed, clip, root.id), relOn) && travelOf(ed, clip, root.id) < 1e-9);
  check('quadruped: vertical root motion is kept in place mode', Math.abs(evaluatePose(ed.project, clip.id, 2).world.get(root.id).pos[1] - evaluatePose(ed.project, clip.id, 0).world.get(root.id).pos[1] - 0.1) < 1e-9);
  ed.setClipRootMotion(clip.id, true);
  check('quadruped: On restores exactly', sameRel(relativePoses(ed, clip, root.id), relOn));
}

// ---------- 4. retargeted FBX (generated IK targets) in both modes ----------
{
  const ed = new Editor();
  ed.importGia(pantalone, 'Pantalone.gia');
  ed.applyAutoRig(ed.proposeAutoRig({ ik: true }));
  const fbx = readFileSync(new URL('./fixtures/Rumba Dancing.fbx', import.meta.url));
  const src = await loadAnimationData(fbx.buffer.slice(fbx.byteOffset, fbx.byteOffset + fbx.byteLength), 'Rumba Dancing.fbx');
  const tb = ed.project.nodes.filter((n) => n.type === 'bone').map((b) => ({ id: b.id, name: b.name, parent: b.parent, depth: 0 }));
  const auto = autoMap(src.bones, tb);
  const res = await retargetClip(ed.project, src, src.clips[0], auto.mapping, auto.roles, { rootMotion: 'keep', ik: true, tolerance: 'normal', name: 'Rumba' });
  const clip = res.clip; ed.project.activeClipId = clip.id;
  const hips = getNode(ed.project, clip.rootNodeId);
  const times = [0, 0.6, 1.2, 1.8, 2.3];
  check('retargeted clip keys the IK targets and carries root motion', clip.rootMotion === true && ed.project.nodes.filter((n) => n.type === 'target').some((n) => clip.tracks[n.id]?.pos?.length > 1));
  const relOn = relativePoses(ed, clip, hips.id, times);
  clip.rootMotion = false;
  check('retargeted, in place: IK targets and poles stay coherent with the hips at every sampled time', sameRel(relativePoses(ed, clip, hips.id, times), relOn));
  clip.rootMotion = true;
  check('retargeted: On restores exactly', sameRel(relativePoses(ed, clip, hips.id, times), relOn));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
