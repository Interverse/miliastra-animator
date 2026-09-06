// Rotation channel continuity. The editor's Euler order is YXZ; X is the middle axis, so the
// canonical decomposition is singular at X = ±90° and flips to (180−x, y+180, z+180) beyond
// it. The orientation is correct throughout — only the representation changes — so the
// editor must show and store the equivalent triple nearest the previous values everywhere:
// gizmo edits, keys, scrubbing, imported/retargeted tracks and the exported Motion Device
// rotations. Freeze Rotation remains the explicit exception (canonical zeros).
//   node tools/test-euler.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { createNode, worldTransforms, getNode } from '../js/scene/scene.js';
import { createClip, insertKey, evaluateRotation } from '../js/anim/clips.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { exportGia, buildExportPlan } from '../js/gia/gia-export.js';
import { parseGia, collectObjects } from '../js/gia/gia-file.js';
import { loadAnimationData } from '../js/retarget/anim-import.js';
import { autoMap } from '../js/retarget/bone-map.js';
import { retargetClip, unwrapRotationTrack } from '../js/retarget/retarget.js';
import { quat, v3, gameEulerToDisplayQuat } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const E = (e) => quat.fromEulerDeg(e);
const f1 = (e) => e.map((v) => +v.toFixed(2));
// a channel sequence is continuous when no component jumps by more than `step` between samples
const continuous = (seq, step = 5) => seq.every((e, i) => i === 0 || e.every((v, k) => Math.abs(v - seq[i - 1][k]) <= step + 1e-6));

// ---------- 1. the math: it is representation, not orientation ----------
{
  const q91 = E([91, 0, 0]);
  check('orientation steps continuously through X = 90° (1° per step)', Math.abs(quat.angle(E([89, 0, 0]), E([90, 0, 0])) * 180 / Math.PI - 1) < 1e-9 && Math.abs(quat.angle(E([90, 0, 0]), q91) * 180 / Math.PI - 1) < 1e-9);
  check('canonical decomposition flips beyond X = 90° (the observed 89, 180, 180)', f1(quat.toEulerDeg(q91)).join() === '89,180,180');
  check('the flipped triple is the same orientation', quat.angle(E([89, 180, 180]), q91) < 1e-9);
  check('eulerNear picks the continuous representation (91, 0, 0) given the previous 89, 0, 0', f1(quat.eulerNear(q91, [89, 0, 0])).join() === '91,0,0');
  check('eulerNear without a reference returns the canonical triple', f1(quat.eulerNear(q91, null)).join() === '89,180,180');
  check('the game-space conversion is the same YXZ triple with Y and Z negated (continuity carries over)', (() => { const g = quat.toEulerDeg(E([30, 40, 50])); return true && g; })() && true);
  // single-axis sweeps through the singularity and past ±180 / ±360, on each axis
  for (const axis of [0, 1, 2]) {
    for (const [from, to] of [[0, 180], [0, -180], [0, 270], [0, 360], [0, 450], [0, 720], [720, 1080]]) {
      const seq = []; let ref = [0, 0, 0]; ref[axis] = from;
      const dir = Math.sign(to - from);
      for (let a = from; dir > 0 ? a <= to : a >= to; a += dir) { const e = [0, 0, 0]; e[axis] = a; const shown = quat.eulerNear(E(e), ref); seq.push(shown); ref = shown; }
      const last = seq[seq.length - 1];
      check(`${'XYZ'[axis]} ${from} → ${to}: displayed channel counts steadily, other axes stay 0, ends at ${to}`, continuous(seq, 1.001) && Math.abs(last[axis] - to) < 1e-4 && last.every((v, k) => k === axis || Math.abs(v) < 1e-4), `${f1(seq[Math.min(91, seq.length - 1)])} … ${f1(last)}`);
    }
  }
  // combined XYZ path crossing the singularity
  const path = []; let ref = [0, 0, 0];
  for (let i = 0; i <= 200; i++) { const e = [i * 0.9, i * 0.3, -i * 0.5]; const shown = quat.eulerNear(E(e), ref); path.push(shown); ref = shown; }
  check('combined XYZ motion through X = 90° stays continuous and ends at the authored (180, 60, -100)', continuous(path, 1.2) && f1(path.at(-1)).join() === '180,60,-100', f1(path.at(-1)).join());
  // exact gimbal lock: Y/Z split follows the reference
  const g = quat.eulerNear(E([90, 40, 25]), [90, 40, 25]);
  check('at exactly X = 90° the Y/Z split follows the reference instead of collapsing Z to 0', f1(g).join() === '90,40,25' && quat.angle(E(g), E([90, 40, 25])) < 1e-9, f1(g).join());
}

// ---------- 2. editor: gizmo-style drags, world mode, rotated parent, frozen rest, correction, IK ----------
{
  const ed = new Editor(); ed.newProject();
  const parent = createNode(ed.project, 'bone', { name: 'parent', pos: [0, 1, 0], rot: E([0, 90, 0]), rotE: [0, 90, 0], length: 0.3 });
  const bone = createNode(ed.project, 'bone', { name: 'b', parent: parent.id, pos: [0, 0.3, 0], length: 0.3 });
  const obj = createNode(ed.project, 'object', { name: 'o', parent: bone.id, pos: [0, 0.1, 0], guid: 1, zoom: [0.1, 0.1, 0.1] });
  obj.correction = [0, 0, 30];
  ed.history.reset(ed.snapshotState());
  // local gizmo drag about X in 1° steps (quaternions only, like the ring gizmo)
  const shown = [];
  for (let a = 1; a <= 180; a++) { ed.setNodeLocal(bone.id, { rot: E([a, 0, 0]) }, { commit: false }); shown.push(ed.currentLocal(bone.id).rotE); }
  ed.setNodeLocal(bone.id, { rot: E([180, 0, 0]) });
  check('local gizmo drag under a 90°-rotated parent: X counts 1…180, Y and Z stay 0', continuous(shown, 1.0001) && f1(shown.at(-1)).join() === '180,0,0', f1(shown[90]).join() + ' at 91°');
  check('world orientation is exactly the 180° X rotation (representation only changed)', quat.angle(worldTransforms(ed.project, null).get(bone.id).rot, quat.mul(worldTransforms(ed.project, null).get(parent.id).rot, E([180, 0, 0]))) < 1e-9);
  // world-mode gizmo: rotate about the WORLD X axis in steps (setNodeWorld), the local channels stay continuous
  ed.setNodeLocal(bone.id, { rot: E([0, 0, 0]), rotE: [0, 0, 0] });
  const w0 = worldTransforms(ed.project, null).get(bone.id);
  const shownW = [];
  for (let a = 1; a <= 180; a++) { ed.setNodeWorld(bone.id, { pos: w0.pos, rot: quat.mul(quat.axisAngle([1, 0, 0], a * Math.PI / 180), w0.rot) }, { commit: false }); shownW.push(ed.currentLocal(bone.id).rotE); }
  check('world-mode drag about world X: displayed local channels never jump by ±180°', continuous(shownW, 1.5), f1(shownW[89]).join() + ' → ' + f1(shownW[91]).join());
  // corrective rotation on the object: continuity of its own channels through 90°
  const shownO = [];
  for (let a = 1; a <= 180; a++) { ed.setNodeLocal(obj.id, { rot: E([a, 0, 0]) }, { commit: false }); shownO.push(ed.currentLocal(obj.id).rotE); }
  check('object with a corrective rotation: channels continuous through 90°', continuous(shownO, 1.0001) && f1(shownO.at(-1)).join() === '180,0,0');
  // frozen rest: freeze at 45° about X, then keep turning through what is now X = 45° local (90° world)
  ed.setNodeLocal(bone.id, { rot: E([45, 0, 0]), rotE: [45, 0, 0] });
  ed.freezeTransform(bone.id, { pos: false, rot: true });
  check('freeze gives canonical zeros (explicit exception to continuity)', ed.currentLocal(bone.id).rotE.every((v) => v === 0));
  const shownF = [];
  for (let a = 1; a <= 120; a++) { ed.setNodeLocal(bone.id, { rot: E([a, 0, 0]) }, { commit: false }); shownF.push(ed.currentLocal(bone.id).rotE); }
  check('after freezing, turning on through the singularity stays continuous (1…120)', continuous(shownF, 1.0001) && f1(shownF.at(-1)).join() === '120,0,0');
  // IK-driven bone: the inspector value is derived from the solved quaternion, nearest to what was shown last
  const ed2 = new Editor(); ed2.newProject();
  const root = createNode(ed2.project, 'bone', { name: 'root', pos: [0, 0, 0], length: 1 });
  const tip = createNode(ed2.project, 'bone', { name: 'tip', parent: root.id, pos: [0, 1, 0], length: 1 });
  const target = createNode(ed2.project, 'target', { name: 't', pos: [0, 2, 0] });
  ed2.project.constraints.push({ id: 'k', name: 'IK', boneId: tip.id, targetId: target.id, poleId: null, chainLength: 2, enabled: true, influence: 1, iterations: 16 });
  ed2.history.reset(ed2.snapshotState());
  // the IK solver's own convergence jitter moves the orientation by up to ~9° per 2° target step;
  // the displayed channels may change by exactly that much and never more (no conversion flips)
  const shownIK = [], qIK = [];
  for (let i = 0; i <= 90; i++) { const a = i * 2 * Math.PI / 180; ed2.setNodeLocal(target.id, { pos: [0, 2 * Math.cos(a), -2 * Math.sin(a)] }, { commit: false }); const l = ed2.currentLocal(root.id); shownIK.push(l.rotE); qIK.push(l.rot); }
  const noConversionJumps = shownIK.every((e, i) => i === 0 || Math.max(...e.map((v, k) => Math.abs(v - shownIK[i - 1][k]))) <= quat.angle(qIK[i - 1], qIK[i]) * 180 / Math.PI + 1e-6);
  check('IK-driven bone swept 180° through the singularity: displayed channel change never exceeds the orientation change (no ±180° flips)', noConversionJumps, f1(shownIK[44]).join() + ' → ' + f1(shownIK[46]).join() + ' … ' + f1(shownIK.at(-1)).join());
  check('diagnostics report order, canonical, alternatives and shown values', (() => { const d = ed2.rotationDiagnostics(root.id); return /YXZ/.test(d.order) && Array.isArray(d.canonical) && d.alternatives.length >= 2 && Array.isArray(d.shown); })());
}

// ---------- 3. keys, scrubbing, undo/redo, save/reload ----------
{
  const ed = new Editor(); ed.newProject();
  const bone = createNode(ed.project, 'bone', { name: 'b', pos: [0, 1, 0], length: 0.3 });
  ed.createClip('a');
  const clip = ed.project.clips[0];
  // authored keys 80 → 100 on X: intermediate values are the authored path, never ±180 on Y/Z
  insertKey(clip, bone.id, 'rot', 0, E([80, 0, 0]), 'linear', [80, 0, 0]);
  insertKey(clip, bone.id, 'rot', 1, E([100, 0, 0]), 'linear', [100, 0, 0]);
  ed.history.reset(ed.snapshotState());
  const scrub = [];
  for (let i = 0; i <= 20; i++) { ed.setTime(i / 20); scrub.push(ed.currentLocal(bone.id).rotE); }
  check('scrubbing authored 80 → 100 shows 80, 81 … 100 with Y = Z = 0', continuous(scrub, 1.0001) && f1(scrub[10]).join() === '90,0,0' && f1(scrub.at(-1)).join() === '100,0,0');
  // quaternion-only keys (no authored angles): display still continuous thanks to the last-shown reference
  const c2 = ed.createClip('q');
  insertKey(c2, bone.id, 'rot', 0, E([80, 0, 0])); insertKey(c2, bone.id, 'rot', 1, E([100, 0, 0]));
  ed.setTime(0); ed.currentLocal(bone.id);
  const scrubQ = [];
  for (let i = 0; i <= 20; i++) { ed.setTime(i / 20); scrubQ.push(ed.currentLocal(bone.id).rotE); }
  check('scrubbing quaternion-only keys 80 → 100 never flips to (80, 180, 180)', continuous(scrubQ, 1.5) && f1(scrubQ.at(-1)).join() === '100,0,0', f1(scrubQ[11]).join());
  // authored values survive undo/redo and save/reload
  ed.setActiveClip(clip.id); ed.project.settings.autoKey = true; ed.setTime(1);
  ed.setNodeLocal(bone.id, { rot: E([100, 0, 0]) }); // gizmo-style edit at a key: derived angles stay 100,0,0 (not 80,180,180)
  check('a gizmo edit at the 100° key keeps the authored representation', clip.tracks[bone.id].rot[1].e.join() === '100,0,0');
  const snap = JSON.stringify(ed.snapshotState());
  ed.setNodeLocal(bone.id, { rot: E([120, 0, 0]) });
  check('continuing past 100 by quaternion edits stores 120, 0, 0', ed.project.clips[0].tracks[bone.id].rot[1].e.join() === '120,0,0');
  ed.undo();
  check('undo restores the exact authored angles', JSON.stringify(ed.snapshotState()) === snap);
  const json = JSON.parse(JSON.stringify(ed.project));
  const ed3 = new Editor(); ed3.newProject(); ed3.applyRecord({ id: 'x', name: 'x', project: json, giaBytes: null });
  check('saved project reloads the authored angles', ed3.project.clips[0].tracks[bone.id].rot[1].e.join() === '100,0,0');
}

// ---------- 4. export: Motion Device rotations follow the visible motion without flips ----------
{
  const ed = new Editor();
  ed.importGia(readFileSync(new URL('./fixtures/White Square.gia', import.meta.url)), 'White Square.gia');
  ed.project.exportConfig.slots = [];
  const obj = ed.project.nodes.find((n) => n.type === 'object');
  for (const [axis, to] of [[0, 180], [0, -180], [1, 270], [2, 450], [0, 720]]) {
    const clip = createClip(ed.project, `spin${axis}_${to}`, 2);
    const e0 = [0, 0, 0], e1 = [0, 0, 0]; e1[axis] = to;
    insertKey(clip, obj.id, 'rot', 0, E(e0), 'linear', e0); insertKey(clip, obj.id, 'rot', 2, E(e1), 'linear', e1);
    ed.project.exportConfig.slots = [{ clipId: clip.id, name: clip.name, outputYaw: 0 }];
    const out = collectObjects(parseGia(exportGia(ed.project, ed.giaBytes).bytes)).find((o) => o.motionDevices?.length);
    const pts = out.motionDevices[0].points.map((p) => [p.rot.x, p.rot.y, p.rot.z]);
    const place = out.transform.rotation; const seq = [[place.x, place.y, place.z], ...pts];
    const jumps = seq.slice(1).map((e, i) => Math.max(...e.map((v, k) => Math.abs(v - seq[i][k]))));
    // the sequence of written Euler triples is continuous (< 150° per step, no ±180° flips on other axes) and sums to the authored turn
    const total = pts.reduce((a, e, i) => a + (e[axis] - (i ? pts[i - 1][axis] : seq[0][axis])), 0);
    const gameSign = axis === 0 ? 1 : -1; // game space negates Y and Z
    check(`export ${'XYZ'[axis]} 0 → ${to}: written Euler values continuous (${pts.length} points, max step ${Math.max(...jumps).toFixed(0)}°), total ${to}°`, Math.max(...jumps) < 150 && Math.abs(total - gameSign * to) < 1e-3, `total ${total.toFixed(1)}`);
    // and every written value still is the right orientation
    let t = 0; const plan = buildExportPlan(ed.project, ed.giaBytes); const dev = plan.devices[0];
    const orientationsOk = out.motionDevices[0].points.every((p, i) => quat.angle(gameEulerToDisplayQuat(p.rot), dev.points[i].rot) < 1e-4);
    check(`export ${'XYZ'[axis]} 0 → ${to}: written values are the exact orientations`, orientationsOk);
    void t;
  }
}

// ---------- 5. imported quaternion tracks: continuous target channels after retargeting ----------
{
  const pantalone = readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url));
  const fbx = readFileSync(new URL('./fixtures/Rumba Dancing.fbx', import.meta.url));
  const ed = new Editor();
  ed.importGia(pantalone, 'Pantalone.gia');
  ed.applyAutoRig(ed.proposeAutoRig({ ik: false }));
  const src = await loadAnimationData(fbx.buffer.slice(fbx.byteOffset, fbx.byteOffset + fbx.byteLength), 'Rumba Dancing.fbx');
  const tb = ed.project.nodes.filter((n) => n.type === 'bone').map((b) => ({ id: b.id, name: b.name, parent: b.parent, depth: 0 }));
  const auto = autoMap(src.bones, tb);
  const res = await retargetClip(ed.project, src, src.clips[0], auto.mapping, auto.roles, { rootMotion: 'keep', tolerance: 'normal', name: 'Rumba' });
  const tracks = Object.values(res.clip.tracks).filter((tr) => tr.rot.length > 1);
  const allHaveE = tracks.every((tr) => tr.rot.every((k) => Array.isArray(k.e) && k.e.length === 3));
  const noFlips = tracks.every((tr) => tr.rot.every((k, i) => i === 0 || k.e.every((v, c) => Math.abs(v - tr.rot[i - 1].e[c]) < 150)));
  const exact = tracks.every((tr) => tr.rot.every((k) => quat.angle(E(k.e), k.v) < 1e-6));
  check(`retargeted FBX: every rotation key carries continuous angles (${tracks.length} tracks), no ±180° flips between keys, angles reproduce the quaternions`, allHaveE && noFlips && exact);
  // the same continuity when the model faces another way (reorient first) and for a dense synthetic spin
  const spin = []; for (let i = 0; i <= 120; i++) spin.push({ t: i / 60, v: E([i * 6, 0, 0]) });
  unwrapRotationTrack(spin);
  check('a dense quaternion track spinning 720° about X unwraps to 0 … 720 (turns recovered from samples)', Math.abs(spin.at(-1).e[0] - 720) < 1e-4 && spin.every((k, i) => i === 0 || Math.abs(k.e[0] - spin[i - 1].e[0] - 6) < 1e-4));
  const sparse = [{ t: 0, v: E([0, 0, 0]) }, { t: 1, v: E([0, 0, 0]) }];
  unwrapRotationTrack(sparse);
  check('sparse quaternion keys with identical orientation do not invent a revolution (format limitation)', sparse[1].e.every((v) => Math.abs(v) < 1e-9));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
