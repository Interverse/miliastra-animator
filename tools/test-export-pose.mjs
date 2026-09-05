// Export placement/rotation regression:  node tools/test-export-pose.mjs
//
// 1. The user-supplied "Bangboo" project: the Body bone's rig rest rotation is
//    -29.38° Y while its animation starts at 0°. The exported placement must be
//    what the editor shows at frame 0 (0°), never the rest pose.
// 2. Generalized: every exported object's placement equals its evaluated frame-0
//    pose, each waypoint carries the absolute world rotation and the position
//    relative to the placement, and re-importing the file reproduces the poses.
// 3. Synthetic: an arbitrary rest/frame-0 mismatch (73°) must not leak either.
import { readFileSync } from 'node:fs';
import { evaluatePose, restWorld } from '../js/anim/evaluate.js';
import { exportGia, exportBasePose, exportSlots } from '../js/gia/gia-export.js';
import { importGia } from '../js/gia/gia-import.js';
import { parseGia, collectObjects } from '../js/gia/gia-file.js';
import { getClip } from '../js/anim/clips.js';
import { createNode } from '../js/scene/scene.js';
import { createClip, insertKey } from '../js/anim/clips.js';
import { quat, v3, gameEulerToDisplayQuat, gameToDisplayPos } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const deg = (q) => quat.toEulerDeg(q).map((a) => +a.toFixed(2));
const ang = (a, b) => quat.angle(a, b) * 180 / Math.PI;

// Every object: placement == frame-0 pose of the initial clip; waypoints consistent.
function verifyExport(project, gia, label) {
  const { bytes } = exportGia(project, gia);
  const out = collectObjects(parseGia(bytes));
  const slots = exportSlots(project);
  const clip = getClip(project, slots[Math.max(0, project.exportConfig.initialSlot | 0)].clipId);
  const base = exportBasePose(project);
  const frame0 = evaluatePose(project, clip.id, 0).world;
  let placementOk = true, wpOk = true, checked = 0, maxRot = 0, maxPos = 0;
  for (const node of project.nodes.filter((n) => n.type === 'object' && n.guid != null)) {
    const o = out.find((x) => x.guid === node.guid);
    if (!o) continue;
    const pl = { pos: gameToDisplayPos(o.transform.position), rot: gameEulerToDisplayQuat(o.transform.rotation) };
    const f0 = frame0.get(node.id);
    const dr = ang(pl.rot, f0.rot), dp = v3.dist(pl.pos, f0.pos);
    maxRot = Math.max(maxRot, dr); maxPos = Math.max(maxPos, dp);
    if (dr > 0.01 || dp > 1e-4) placementOk = false;
    // waypoints: absolute rotation at their time, position relative to the placement
    for (const dev of o.motionDevices) {
      let t = 0;
      for (const p of dev.points) {
        t += p.duration;
        const w = evaluatePose(project, clip.id, Math.min(t, clip.duration)).world.get(node.id);
        const wr = gameEulerToDisplayQuat(p.rot);
        const wp = v3.add(base.get(node.id).pos, gameToDisplayPos(p.pos));
        // baked segments are linear approximations; compare at the segment end (an authored sample)
        if (ang(wr, w.rot) > 1.0 || v3.dist(wp, w.pos) > 0.01) wpOk = false;
        checked++;
      }
    }
  }
  check(`${label}: placement of every object == editor pose at frame 0`, placementOk, `max Δrot ${maxRot.toFixed(3)}° Δpos ${maxPos.toExponential(1)}`);
  check(`${label}: every waypoint = absolute world rotation + placement-relative position (${checked} points)`, wpOk);
  // round trip: re-import reproduces the exported placement and device poses
  const re = importGia(bytes, 'x.gia').project;
  let rtOk = true;
  for (const node of project.nodes.filter((n) => n.type === 'object' && n.guid != null)) {
    const rn = re.nodes.find((n) => n.guid === node.guid);
    if (!rn) continue;
    const f0 = frame0.get(node.id);
    if (ang(rn.rot, f0.rot) > 0.01 || v3.dist(rn.pos, f0.pos) > 1e-4) rtOk = false;
  }
  check(`${label}: re-imported placement matches the editor frame-0 pose`, rtOk);
  return { bytes, out };
}

// ---------- 1 + 2. supplied project ----------
{
  const j = JSON.parse(readFileSync(new URL('./fixtures/bangboo.animator.json', import.meta.url), 'utf8'));
  const p = j.project;
  const gia = Uint8Array.from(Buffer.from(j.gia, 'base64'));
  const body = p.nodes.find((n) => n.type === 'object' && n.name === 'Body');
  const rest = restWorld(p).get(body.id);
  const f0 = evaluatePose(p, p.clips[0].id, 0).world.get(body.id);
  check('fixture reproduces the report: rest Y ≈ -29.38° but frame 0 shows 0°', Math.abs(deg(rest.rot)[1] + 29.38) < 0.05 && ang(f0.rot, [0, 0, 0, 1]) < 0.01, `rest ${deg(rest.rot)} frame0 ${deg(f0.rot)}`);
  const { out } = verifyExport(p, gia, 'Bangboo');
  const bodyOut = out.find((o) => o.guid === body.guid);
  check('Body exported with Y rotation 0 (editor), not 29.38 (rest)', Math.abs(bodyOut.transform.rotation.y) < 0.01, JSON.stringify(bodyOut.transform.rotation));
  check('Body position unchanged', Math.abs(bodyOut.transform.position.y - 0.18879497051239014) < 1e-6);
  check('initial animation starts without a snap point', bodyOut.motionDevices[0].points[0].rot.y === 0 && bodyOut.motionDevices[0].points[0].pos.y === 0);
}

// ---------- 3. synthetic: arbitrary rest/frame-0 mismatch, parent + correction ----------
{
  const j = JSON.parse(readFileSync(new URL('./fixtures/bangboo.animator.json', import.meta.url), 'utf8'));
  const gia = Uint8Array.from(Buffer.from(j.gia, 'base64'));
  const p = importGia(gia, 'b.gia').project;
  const obj = p.nodes.find((n) => n.type === 'object' && n.name === 'Head');
  const bone = createNode(p, 'bone', { name: 'root', pos: [0.2, 0.1, -0.3], rot: quat.fromEulerDeg([0, 73, 0]), length: 0.3 });
  obj.parent = bone.id; obj.pos = [0, 0, 0]; obj.rot = quat.fromEulerDeg([10, 0, 0]);
  obj.correction = [0, 0, 15];
  const clip = createClip(p, 'Turn', 1);
  p.activeClipId = clip.id;
  p.exportConfig.slots = [{ clipId: clip.id, name: 'Turn', outputYaw: 0 }];
  insertKey(clip, bone.id, 'rot', 0, quat.fromEulerDeg([0, -20, 0])); insertKey(clip, bone.id, 'rot', 1, quat.fromEulerDeg([0, 40, 0]));
  insertKey(clip, bone.id, 'pos', 0, [0.2, 0.1, -0.3]); insertKey(clip, bone.id, 'pos', 1, [0.5, 0.1, -0.3]);
  verifyExport(p, gia, 'synthetic 73° rest mismatch');
  const restQ = restWorld(p).get(obj.id).rot, f0 = evaluatePose(p, clip.id, 0).world.get(obj.id).rot;
  check('synthetic: rest and frame 0 really differ', ang(restQ, f0) > 60);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
