// IK targets and poles as first-class animation controls:  node tools/test-ik-controls.mjs
import { readFileSync } from 'node:fs';
import { Editor, isPositionOnly } from '../js/ui/editor.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { exportGia } from '../js/gia/gia-export.js';
import { parseGia, collectObjects } from '../js/gia/gia-file.js';
import { track } from '../js/anim/clips.js';
import { quat, v3 } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const ang = (a, b) => quat.angle(a, b) * 180 / Math.PI;

const j = JSON.parse(readFileSync(new URL('./fixtures/bangboo.animator.json', import.meta.url), 'utf8'));
const gia = Uint8Array.from(Buffer.from(j.gia, 'base64'));
const ed = new Editor();
ed.openProjectFile(JSON.stringify(j));
const P = () => ed.project;
const k = P().constraints[0];
const target = P().nodes.find((n) => n.id === k.targetId);
const tipBone = P().nodes.find((n) => n.id === k.boneId);
const rootBone = P().nodes.find((n) => n.id === tipBone.parent);
const legObj = P().nodes.find((n) => n.type === 'object' && n.parent === rootBone.id);
check('fixture: an enabled IK constraint with a target on a 2-bone chain', !!target && k.enabled && k.chainLength === 2 && !!legObj, `${k.name}`);
ed.setTime(0.5);

// ---------- tool availability ----------
ed.select(target.id); ed.setTool('move');
check('target: position-only, tools = Move', isPositionOnly(target) && ed.availableTools().join() === 'move');
check('Space keeps Move for a target', ed.cycleTool() === 'move' && ed.cycleTool() === 'move');
ed.setTool('rotate');
check('Rotate cannot be activated on a target', ed.tool === 'move');
ed.select(tipBone.id);
check('bone after target: Move + Rotate again', ed.availableTools().join() === 'move,rotate' && ed.cycleTool() === 'rotate');
ed.select(target.id);
check('switching back to the target drops Rotate for Move', ed.tool === 'move');

// ---------- moving the target drives the chain in real time ----------
const poseBefore = evaluatePose(P(), P().activeClipId, ed.time).world;
const tipBefore = poseBefore.get(tipBone.id), rootBefore = poseBefore.get(rootBone.id);
const w = poseBefore.get(target.id);
ed.setNodeWorld(target.id, { pos: v3.add(w.pos, [0.15, 0.1, 0.05]), rot: w.rot });
const poseAfter = evaluatePose(P(), P().activeClipId, ed.time).world;
check('chain bones re-solve when the target moves', ang(poseAfter.get(tipBone.id).rot, tipBefore.rot) > 1 || ang(poseAfter.get(rootBone.id).rot, rootBefore.rot) > 1);
check('the bone-driven object follows', v3.dist(poseAfter.get(legObj.id).pos, poseBefore.get(legObj.id).pos) > 1e-4 || ang(poseAfter.get(legObj.id).rot, poseBefore.get(legObj.id).rot) > 1);

// ---------- rotation never keyed / stored for targets ----------
P().settings.autoKey = true; ed.commit('ak');
ed.setNodeWorld(target.id, { pos: v3.add(w.pos, [0.2, 0.1, 0.05]), rot: quat.fromEulerDeg([0, 45, 0]) });
const tr = track(P().clips.find((c) => c.id === P().activeClipId), target.id);
check('Auto Key on a target keys position only (no rotation track)', tr.pos.length >= 1 && tr.rot.length === 0);
ed.insertKeyframe([target.id]);
check('Insert Keyframe on a target keys position only', track(P().clips.find((c) => c.id === P().activeClipId), target.id).rot.length === 0);

// ---------- keys at several frames ----------
ed.setTime(1.0); ed.setNodeWorld(target.id, { pos: v3.add(w.pos, [-0.1, 0.2, 0]), rot: w.rot });
ed.setTime(1.5); ed.setNodeWorld(target.id, { pos: v3.add(w.pos, [0, 0, 0.2]), rot: w.rot });
const trk = track(P().clips.find((c) => c.id === P().activeClipId), target.id);
check('target keyed at three frames', [0.5, 1.0, 1.5].every((tm) => trk.pos.some((kk) => Math.abs(kk.t - tm) < 1e-6)));
const tipAt = (tm) => evaluatePose(P(), P().activeClipId, tm).world.get(tipBone.id).rot;
check('the chain pose differs per keyed frame', ang(tipAt(0.5), tipAt(1.0)) > 1 && ang(tipAt(1.0), tipAt(1.5)) > 1);
ed.setTime(0.75);
ed.select(tipBone.id); ed.select(target.id);
check('scrubbing + reselecting keeps the target editable (Move available, interaction idle)', ed.availableTools().join() === 'move' && ed.interactionKind === 'idle');

// ---------- unkeyed frame: drag is authoritative until committed ----------
P().settings.autoKey = false; ed.commit('ak off');
ed.setTime(0.8);
const evalPos = evaluatePose(P(), P().activeClipId, 0.8).world.get(target.id).pos;
ed.beginInteraction('gizmo-move', { finish: () => ed.commit('move') });
ed.setNodeWorld(target.id, { pos: v3.add(evalPos, [0.3, 0, 0]), rot: [0, 0, 0, 1] }, { commit: false });
const during = ed.pose().world.get(target.id).pos;
check('during a drag at an unkeyed frame the live position wins over evaluation', v3.dist(during, v3.add(evalPos, [0.3, 0, 0])) < 1e-9 && ed.hasPoseOverride(target.id, 'pos'));
ed.finishInteraction();
check('drag = one history step, chain follows the live target', ed.history.undoLabel() === 'move' && ang(evaluatePose(P(), P().activeClipId, 0.8, { overrides: ed.activeOverrides() }).world.get(tipBone.id).rot, tipAt(0.8)) > 0.5);

// ---------- pole ----------
ed.setTime(0.5);
P().settings.autoKey = true; ed.commit('ak');
// put the target within reach so the chain actually bends (a straight, stretched chain has no bend to steer)
const rootW = evaluatePose(P(), P().activeClipId, 0.5).world.get(rootBone.id).pos;
const total = v3.len(tipBone.pos) + (tipBone.length || 0.25);
ed.select(target.id);
ed.setNodeWorld(target.id, { pos: v3.add(rootW, v3.scale(v3.norm([0.3, -0.9, 0.3]), total * 0.7)), rot: [0, 0, 0, 1] });
const pole = ed.addPoleFor(k.id);
check('pole created and selected, position-only', !!pole && ed.active === pole.id && isPositionOnly(pole) && ed.availableTools().join() === 'move');
ed.setNodeWorld(pole.id, { pos: v3.add(rootW, [0.6, 0, 0]), rot: [0, 0, 0, 1] });
const midBefore = evaluatePose(P(), P().activeClipId, 0.5).world.get(tipBone.id).pos.slice();
ed.setNodeWorld(pole.id, { pos: v3.add(rootW, [0, 0, 0.6]), rot: [0, 0, 0, 1] });
const midAfter = evaluatePose(P(), P().activeClipId, 0.5).world.get(tipBone.id).pos;
check('moving the pole changes the bend (joint position)', v3.dist(midAfter, midBefore) > 1e-4, `${v3.dist(midAfter, midBefore).toExponential(2)}`);
const reachErr = () => { const e = evaluatePose(P(), P().activeClipId, 0.5).world; const te = e.get(tipBone.id); return v3.dist(v3.add(te.pos, quat.rotate(te.rot, [0, tipBone.length || 0.25, 0])), e.get(target.id).pos); };
check('the chain still reaches the target after the pole moved (solver tolerance)', reachErr() < total * 0.1, `reach error ${reachErr().toExponential(2)} of chain ${total.toFixed(3)}`);
const pw = { pos: v3.add(rootW, [0, 0, 0.6]), rot: [0, 0, 0, 1] };
ed.setNodeWorld(pole.id, { pos: v3.add(pw.pos, [0, 0.1, 0]), rot: pw.rot });
const ptr = track(P().clips.find((c) => c.id === P().activeClipId), pole.id);
check('pole Auto Key: position track only', ptr && ptr.pos.length >= 1 && ptr.rot.length === 0);

// ---------- undo / redo ----------
const polePos = ed.pose().world.get(pole.id).pos.slice();
ed.undo();
check('undo restores the pole', v3.dist(ed.pose().world.get(pole.id).pos, polePos) > 1e-6);
ed.redo();
check('redo restores it again', v3.dist(ed.pose().world.get(pole.id).pos, polePos) < 1e-9);

// ---------- export: keyed controls drive the baked pose; controls themselves are not exported ----------
const { bytes } = exportGia(P(), gia);
const out = collectObjects(parseGia(bytes));
check('no target/pole objects in the exported file', out.every((o) => o.name !== target.name && o.name !== pole.name) && out.length === collectObjects(parseGia(gia)).length + 1);
const legOut = out.find((o) => o.guid === legObj.guid);
check('bone-driven object got a device record (its motion comes from the keyed target)', legOut.motionDevices.length === 1 && legOut.motionDevices[0].points.length > 2);

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
