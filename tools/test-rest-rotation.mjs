// Rotated rest pose:  node tools/test-rest-rotation.mjs
// The placement written to the .gia (what the engine returns to between plays)
// must be the frame-0 pose turned by the reference animation's output rotation
// about the export pivot, and the reference animation's first waypoint must
// resolve to exactly that pose (no snap). Other slots keep their own rotation.
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { exportGia, exportBasePose, exportPlacement, exportPivot, outputRotation, rotateAboutPivot, referenceYaw } from '../js/gia/gia-export.js';
import { importGia } from '../js/gia/gia-import.js';
import { parseGia, collectObjects } from '../js/gia/gia-file.js';
import { createNode } from '../js/scene/scene.js';
import { createClip, insertKey } from '../js/anim/clips.js';
import { quat, v3, gameEulerToDisplayQuat, gameToDisplayPos } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const ang = (a, b) => quat.angle(a, b) * 180 / Math.PI;
const MIN = 0.0300001;

const j = JSON.parse(readFileSync(new URL('./fixtures/bangboo.animator.json', import.meta.url), 'utf8'));
const gia = Uint8Array.from(Buffer.from(j.gia, 'base64'));
function buildScene(slotDefs, initialSlot = 0) {
  const ed = new Editor();
  ed.importGia(gia, 'b.gia');
  const p = ed.project;
  p.clips = []; p.constraints = []; p.exportConfig.slots = [];
  p.settings.globalOffset = [1.5, 0, -2];
  const objs = p.nodes.filter((n) => n.type === 'object');
  const [A, B, C, D] = objs;
  for (const o of objs) o.parent = null;
  A.pos = [0.8, 0.1, 0.3]; A.rot = [0, 0, 0, 1];
  B.pos = [-0.6, 0.4, 0.2]; B.rot = quat.fromEulerDeg([0, 20, 0]); B.correction = [0, 0, 15];
  const root = createNode(p, 'bone', { name: 'root', pos: [0.2, 0, -0.5], rot: quat.fromEulerDeg([0, 30, 0]), length: 0.3 });
  const child = createNode(p, 'bone', { name: 'child', parent: root.id, pos: [0, 0.3, 0], rot: quat.fromEulerDeg([25, 0, 0]), length: 0.2 });
  C.parent = child.id; C.pos = [0.1, 0.2, 0]; C.rot = quat.fromEulerDeg([0, 0, 40]); C.correction = [10, 0, 0];
  D.parent = root.id; D.pos = [0, 0, 0.4]; D.rot = [0, 0, 0, 1];
  const walk = createClip(p, 'Walk', 1);
  insertKey(walk, A.id, 'pos', 0, A.pos); insertKey(walk, A.id, 'pos', 1, v3.add(A.pos, [0.5, 0.2, 0]));
  insertKey(walk, root.id, 'rot', 0, root.rot); insertKey(walk, root.id, 'rot', 1, quat.fromEulerDeg([0, 110, 0]));
  insertKey(walk, child.id, 'rot', 0, child.rot); insertKey(walk, child.id, 'rot', 0.5, quat.fromEulerDeg([25, 0, 35])); insertKey(walk, child.id, 'rot', 1, child.rot);
  const wave = createClip(p, 'Wave', 0.8); // starts from a different pose
  insertKey(wave, root.id, 'rot', 0, quat.fromEulerDeg([0, 60, 0])); insertKey(wave, root.id, 'rot', 0.8, quat.fromEulerDeg([0, 30, 0]));
  p.activeClipId = walk.id;
  p.exportConfig.slots = slotDefs.map(([name, yaw]) => ({ clipId: name === 'Wave' ? wave.id : walk.id, name: `${name} ${yaw}`, outputYaw: yaw }));
  p.exportConfig.initialSlot = initialSlot;
  ed.history.reset(ed.snapshotState());
  return { ed, p, objs, clips: { Walk: walk, Wave: wave } };
}

function verify(slotDefs, initialSlot, label) {
  const { p, objs, clips } = buildScene(slotDefs, initialSlot);
  const pivot = exportPivot(p);
  const refYaw = referenceYaw(p);
  const refClip = clips[slotDefs[initialSlot][0]];
  const base = exportBasePose(p), placement = exportPlacement(p);
  const { bytes } = exportGia(p, gia);
  const out = collectObjects(parseGia(bytes));
  const Rref = outputRotation(refYaw);
  // 1. placement = frame-0 pose of the reference clip turned about the pivot
  let plOk = true, spacingOk = true, maxD = 0;
  for (const node of objs) {
    const o = out.find((x) => x.guid === node.guid);
    const filePl = { pos: gameToDisplayPos(o.transform.position), rot: gameEulerToDisplayQuat(o.transform.rotation) };
    const expected = rotateAboutPivot(evaluatePose(p, refClip.id, 0).world.get(node.id), Rref, pivot);
    const d = v3.dist(filePl.pos, expected.pos), r = ang(filePl.rot, expected.rot);
    maxD = Math.max(maxD, d, r / 100);
    if (d > 1e-4 || r > 0.01) plOk = false;
    if (v3.dist(filePl.pos, placement.get(node.id).pos) > 1e-6) plOk = false;
  }
  for (let i = 0; i < objs.length; i++) for (let k = i + 1; k < objs.length; k++) {
    const a = placement.get(objs[i].id).pos, b = placement.get(objs[k].id).pos, a0 = base.get(objs[i].id).pos, b0 = base.get(objs[k].id).pos;
    if (Math.abs(v3.dist(a, b) - v3.dist(a0, b0)) > 1e-9) spacingOk = false;
  }
  check(`${label}: rest placement = reference frame-0 pose turned by ${refYaw}° about the pivot`, plOk, `max Δ ${maxD.toExponential(1)}`);
  check(`${label}: spacing between pieces preserved in the rest pose`, spacingOk);
  check(`${label}: reference orientation actually turned`, refYaw === 0 || objs.every((n) => Math.abs(ang(placement.get(n.id).rot, base.get(n.id).rot) - Math.min(refYaw % 360, 360 - refYaw % 360)) < 1e-6));
  // 2. reference slot: first waypoint resolves to the placement, and is not a 30 ms snap
  let noSnap = true;
  for (const node of objs) {
    const o = out.find((x) => x.guid === node.guid);
    const dev = o.motionDevices[initialSlot];
    if (!dev) continue; // static object without a device: it simply rests
    const p0 = dev.points[0];
    const pose0 = { pos: v3.add(placement.get(node.id).pos, gameToDisplayPos(p0.pos)), rot: gameEulerToDisplayQuat(p0.rot) };
    // the motion starts from the placement; a leading 30 ms point may only exist if it IS the placement
    const differs = v3.dist(pose0.pos, placement.get(node.id).pos) > 1e-4 || ang(pose0.rot, placement.get(node.id).rot) > 0.01;
    if (p0.duration <= MIN && differs) noSnap = false;
  }
  check(`${label}: reference animation starts exactly at the rest placement (no snap)`, noSnap);
  // 3. every slot's waypoints still equal the evaluated pose turned by its own rotation
  let allOk = true;
  slotDefs.forEach(([name, yaw], si) => {
    const R = outputRotation(yaw), clip = clips[name];
    for (const node of objs) {
      const o = out.find((x) => x.guid === node.guid);
      const dev = o.motionDevices[si];
      if (!dev) continue;
      let t = 0;
      dev.points.forEach((pt, i) => {
        if (!(i === 0 && dev.points.length > 1 && pt.duration <= MIN)) t += pt.duration;
        const expected = rotateAboutPivot(evaluatePose(p, clip.id, Math.min(t, clip.duration)).world.get(node.id), R, pivot);
        const got = { pos: v3.add(placement.get(node.id).pos, gameToDisplayPos(pt.pos)), rot: gameEulerToDisplayQuat(pt.rot) };
        if (v3.dist(got.pos, expected.pos) > 0.01 || ang(got.rot, expected.rot) > 1.0) allOk = false;
      });
    }
  });
  check(`${label}: every slot's waypoints = evaluated pose turned by its own output rotation`, allOk);
  // 4. re-import
  const re = importGia(bytes, 'r.gia').project;
  let rtOk = true;
  for (const node of objs) {
    const rn = re.nodes.find((n) => n.guid === node.guid);
    if (v3.dist(rn.pos, placement.get(node.id).pos) > 1e-4 || ang(rn.rot, placement.get(node.id).rot) > 0.01) rtOk = false;
  }
  check(`${label}: re-imported rest pose equals the rotated placement`, rtOk);
}

verify([['Walk', 90]], 0, 'single 90°');
verify([['Walk', 180]], 0, 'single 180°');
verify([['Walk', 45]], 0, 'single 45°');
verify([['Walk', 29.38]], 0, 'single 29.38°');
verify([['Walk', 90], ['Walk', 180], ['Wave', 270], ['Walk', 0]], 0, 'multi (reference = first)');
verify([['Walk', 0], ['Wave', 135], ['Walk', 270]], 1, 'multi (reference = initial slot 2)');

// the Bangboo fixture with a rotated single slot: no snap, placement rotated
{
  const p = j.project;
  p.exportConfig.slots = [{ clipId: p.clips[0].id, name: 'Fancy', outputYaw: 90 }]; p.exportConfig.initialSlot = 0;
  const { bytes } = exportGia(p, Uint8Array.from(Buffer.from(j.gia, 'base64')));
  const out = collectObjects(parseGia(bytes));
  const hand = p.nodes.find((n) => n.type === 'object' && n.name === 'Hand_R');
  const o = out.find((x) => x.guid === hand.guid);
  const pl = gameToDisplayPos(o.transform.position);
  const expected = rotateAboutPivot(evaluatePose(p, p.clips[0].id, 0).world.get(hand.id), outputRotation(90), [0, 0, 0]);
  check('Bangboo 90°: Hand_R rests at the rotated position', v3.dist(pl, expected.pos) < 1e-4, `${pl.map((x) => x.toFixed(3))} vs ${expected.pos.map((x) => x.toFixed(3))}`);
  check('Bangboo 90°: first waypoint is not a snap', !(o.motionDevices[0].points[0].duration <= MIN && o.motionDevices[0].points.length > 1 && (Math.abs(o.motionDevices[0].points[0].pos.x) > 1e-4 || Math.abs(o.motionDevices[0].points[0].pos.z) > 1e-4)));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
