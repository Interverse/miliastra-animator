// Multi-turn rotations: keyframes keep the authored (unwrapped) Euler angles, interpolation
// follows the authored number and direction of turns, edits accumulate beyond ±360°, and
// persistence / copy / undo / baking / export preserve the turns.   node tools/test-rotation.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { createNode } from '../js/scene/scene.js';
import { createClip, insertKey, evaluateRotation, copyKeys, pasteKeys, moveKeys, duplicateClip, keyRef } from '../js/anim/clips.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { bakeClip } from '../js/anim/bake.js';
import { compressPath } from '../js/anim/path-compress.js';
import { buildExportPlan, exportGia } from '../js/gia/gia-export.js';
import { parseGia, collectObjects } from '../js/gia/gia-file.js';
import { quat, v3, unwrapDeg, gameEulerToDisplayQuat } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const E = (e) => quat.fromEulerDeg(e);
const yawOf = (q) => quat.toEulerDeg(q)[1];

// ---------- 1. interpolation follows the authored turns ----------
{
  const cases = [[0, 360], [0, 450], [0, 720], [0, 1080], [0, -360], [0, -720], [720, 1080], [0, -270]];
  for (const [a, b] of cases) {
    const keys = [{ t: 0, v: E([0, a, 0]), i: 'linear', e: [0, a, 0] }, { t: 1, v: E([0, b, 0]), i: 'linear', e: [0, b, 0] }];
    // total signed rotation about Y accumulated over fine steps
    let total = 0, prev = yawOf(evaluateRotation(keys, 0).q);
    for (let i = 1; i <= 200; i++) { const y = yawOf(evaluateRotation(keys, i / 200).q); let d = y - prev; d = ((d % 360) + 540) % 360 - 180; total += d; prev = y; }
    check(`${a}° → ${b}°: plays ${b - a}° of rotation (${(b - a) / 360} turn(s)), authored angle at t=0.5 = ${(a + b) / 2}°`, Math.abs(total - (b - a)) < 1e-6 && Math.abs(evaluateRotation(keys, 0.5).e[1] - (a + b) / 2) < 1e-9, `${total.toFixed(2)}°`);
  }
  // multiple axes beyond ±360°
  const keys = [{ t: 0, v: E([0, 0, 0]), i: 'linear', e: [0, 0, 0] }, { t: 1, v: E([720, -450, 1080]), i: 'linear', e: [720, -450, 1080] }];
  check('multi-axis authored angles interpolate component-wise', evaluateRotation(keys, 0.5).e.join() === '360,-225,540' && quat.angle(evaluateRotation(keys, 0.5).q, E([360, -225, 540])) < 1e-9);
  // keys without authored angles still take the shortest arc
  const q = [{ t: 0, v: E([0, 0, 0]), i: 'linear' }, { t: 1, v: E([0, 270, 0]), i: 'linear' }];
  check('quaternion-only keys (IK / retarget / baked) keep shortest-arc slerp', Math.abs(yawOf(evaluateRotation(q, 0.5).q) - (-45)) < 1e-6 && evaluateRotation(q, 0.5).e === null);
  // eased and stepped interpolation respect the turns too
  const eased = [{ t: 0, v: E([0, 0, 0]), i: 'ease', e: [0, 0, 0] }, { t: 1, v: E([0, 720, 0]), i: 'ease', e: [0, 720, 0] }];
  check('eased interpolation: 720° at the end, 360° at the middle', evaluateRotation(eased, 0.5).e[1] === 360 && evaluateRotation(eased, 0.25).e[1] < 180);
  const stepped = [{ t: 0, v: E([0, 0, 0]), i: 'step', e: [0, 0, 0] }, { t: 1, v: E([0, 720, 0]), i: 'step', e: [0, 720, 0] }];
  check('stepped keys hold the authored angle', evaluateRotation(stepped, 0.9).e[1] === 0 && evaluateRotation(stepped, 1).e[1] === 720);
  check('unwrapDeg picks the representation nearest the reference', unwrapDeg([90, -170, 0], [450, 190, 720]).join() === '450,190,720');
}

// ---------- 2. editor: typed values are kept, gizmo-style edits accumulate, undo/redo/save preserve ----------
{
  const ed = new Editor();
  ed.newProject();
  const b = createNode(ed.project, 'bone', { name: 'spin', pos: [0, 1, 0], length: 0.3 });
  ed.createClip('Spin');
  ed.history.reset(ed.snapshotState());
  ed.project.settings.autoKey = true;
  ed.setTime(0); ed.setNodeLocal(b.id, { rot: E([0, 0, 0]), rotE: [0, 0, 0] });
  ed.setTime(1); ed.setNodeLocal(b.id, { rot: E([0, 1080, 0]), rotE: [0, 1080, 0] });
  const clip = ed.project.clips[0];
  check('typed 1080° is stored verbatim in the key', clip.tracks[b.id].rot[1].e.join() === '0,1080,0');
  ed.setTime(0.5);
  check('the Properties value at t=0.5 reads 540° (authored path), world pose = 180°', ed.currentLocal(b.id).rotE[1] === 540 && Math.abs(Math.abs(yawOf(evaluatePose(ed.project, clip.id, 0.5).world.get(b.id).rot)) - 180) < 1e-6);
  // a gizmo-style drag: many small quaternion updates without authored angles accumulate past 360°
  ed.project.settings.autoKey = false;
  const ed2 = new Editor(); ed2.newProject();
  const b2 = createNode(ed2.project, 'bone', { name: 'drag', pos: [0, 1, 0], length: 0.3 });
  ed2.history.reset(ed2.snapshotState());
  for (let deg = 10; deg <= 720; deg += 10) ed2.setNodeLocal(b2.id, { rot: E([0, deg, 0]) }, { commit: false });
  ed2.setNodeLocal(b2.id, { rot: E([0, 720, 0]) });
  check('two full gizmo turns display 720°, not 0°', ed2.currentLocal(b2.id).rotE[1] === 720);
  ed2.setNodeLocal(b2.id, { rot: E([0, 0, 0]), rotE: [0, 450, 0] });
  check('rotation fields accept 450°', ed2.currentLocal(b2.id).rotE[1] === 450);
  // persistence round trip
  const json = JSON.parse(JSON.stringify(ed.project));
  const ed3 = new Editor(); ed3.newProject();
  ed3.applyRecord({ id: 'x', name: 'x', project: json, giaBytes: null });
  check('saving and reopening keeps Y = 1080°', ed3.project.clips[0].tracks[b.id].rot[1].e[1] === 1080 && evaluateRotation(ed3.project.clips[0].tracks[b.id].rot, 0.5).e[1] === 540);
  // copy / paste / move / duplicate
  const refs = new Set([keyRef(b.id, 'rot', 0), keyRef(b.id, 'rot', 1)]);
  const cb = copyKeys(clip, refs);
  const c2 = createClip(ed.project, 'Copy', 3);
  pasteKeys(c2, cb, 1);
  check('copy/paste keeps authored angles', c2.tracks[b.id].rot[1].e[1] === 1080);
  moveKeys(c2, new Set([keyRef(b.id, 'rot', 2)]), 0.5);
  check('moving a key keeps its authored angle', c2.tracks[b.id].rot[1].t === 2.5 && c2.tracks[b.id].rot[1].e[1] === 1080);
  const dup = duplicateClip(ed.project, clip);
  check('duplicating a clip keeps authored angles', dup.tracks[b.id].rot[1].e[1] === 1080);
  // undo / redo (the clips added above bypassed history: commit them first)
  ed.commit('setup');
  const before = JSON.stringify(ed.snapshotState());
  ed.setTime(1); ed.project.settings.autoKey = true; ed.setNodeLocal(b.id, { rot: E([0, 720, 0]), rotE: [0, 720, 0] });
  check('edit to 720° keyed', ed.project.clips[0].tracks[b.id].rot[1].e[1] === 720);
  ed.undo();
  check('undo restores 1080° exactly', JSON.stringify(ed.snapshotState()) === before);
  ed.redo();
  check('redo restores 720°', ed.project.clips[0].tracks[b.id].rot[1].e[1] === 720);
}

// ---------- 3. baking and export keep every revolution ----------
{
  const ed = new Editor();
  ed.importGia(readFileSync(new URL('./fixtures/White Square.gia', import.meta.url)), 'White Square.gia');
  ed.project.exportConfig.slots = [];
  const obj = ed.project.nodes.find((n) => n.type === 'object');
  const turns = [[0, 360], [0, 450], [0, 720], [0, 1080], [0, -360], [0, -720], [720, 1080]];
  for (const [a, b] of turns) {
    const clip = createClip(ed.project, `t${a}_${b}`, 2);
    insertKey(clip, obj.id, 'rot', 0, E([0, a, 0]), 'linear', [0, a, 0]);
    insertKey(clip, obj.id, 'rot', 2, E([0, b, 0]), 'linear', [0, b, 0]);
    const baked = bakeClip(ed.project, clip).points.get(obj.id);
    // signed rotation accumulated along the baked segments (each < 150°, so the direction is unambiguous)
    let total = 0, prev = 0, maxSeg = 0;
    for (const p of baked.points) { const y = yawOf(p.rot); let d = y - prev; d = ((d % 360) + 540) % 360 - 180; total += d; maxSeg = Math.max(maxSeg, Math.abs(d)); prev = y; }
    check(`bake ${a}→${b}: ${baked.points.length} segments, all < 150°, total ${b - a}°`, Math.abs(total - (b - a)) < 1e-6 && maxSeg < 150.0001, `${total.toFixed(1)}° (max seg ${maxSeg.toFixed(1)}°)`);
    ed.project.exportConfig.slots = [{ clipId: clip.id, name: clip.name, outputYaw: 0 }];
    const plan = buildExportPlan(ed.project, ed.giaBytes);
    const out = collectObjects(parseGia(exportGia(ed.project, ed.giaBytes, { plan }).bytes)).find((o) => o.motionDevices?.length);
    let tot2 = 0, prev2 = 0;
    for (const p of out.motionDevices[0].points) { const y = yawOf(gameEulerToDisplayQuat(p.rot)); let d = y - prev2; d = ((d % 360) + 540) % 360 - 180; tot2 += d; prev2 = y; }
    check(`export ${a}→${b}: the .gia path turns ${b - a}° (${out.motionDevices[0].points.length} points)`, Math.abs(tot2 - (b - a)) < 1e-6, `${tot2.toFixed(1)}°`);
  }
  // compression never merges across a turn
  const clip = createClip(ed.project, 'spin', 2);
  insertKey(clip, obj.id, 'rot', 0, E([0, 0, 0]), 'linear', [0, 0, 0]);
  insertKey(clip, obj.id, 'rot', 2, E([0, 1080, 0]), 'linear', [0, 1080, 0]);
  const baked = bakeClip(ed.project, clip).points.get(obj.id);
  const r = compressPath(baked.points, { maxPoints: 3 });
  let totR = 0, prevR = 0;
  for (const p of r.points) { const y = yawOf(p.rot); let d = y - prevR; d = ((d % 360) + 540) % 360 - 180; totR += d; prevR = y; }
  check('path compression refuses to collapse revolutions: 3 points impossible, all 1080° kept', !r.reached && Math.abs(totR - 1080) < 1e-6, `${r.after} points, ${totR.toFixed(0)}°`);
  const r2 = compressPath(baked.points, { maxPoints: 200, tolerance: { pos: 1, rot: 5 } });
  let tot3 = 0, prev3 = 0;
  for (const p of r2.points) { const y = yawOf(p.rot); let d = y - prev3; d = ((d % 360) + 540) % 360 - 180; tot3 += d; prev3 = y; }
  check('tolerance compression keeps the full 1080° of visible rotation', Math.abs(tot3 - 1080) < 1e-6, `${tot3.toFixed(1)}°`);
  void v3;
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
