// Output rotation = rigid rotation of the whole model about the export pivot.
//   node tools/test-output-rotation.mjs
// Model: several objects away from the origin (standalone, bone-driven through a
// two-level hierarchy, corrective offset, global position offset), one clip
// exported in slots 0° / 90° / 180° / 270° / 29.38° (+ a separate 45° run).
// For every slot, object and waypoint: the pose rebuilt from the file must equal
// the evaluated pose rotated about the pivot, spacing between pieces must be
// unchanged, orientations must turn with the arrangement, the viewport preview
// must match the file, and a re-import must reproduce it.
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

// ---------- model ----------
const j = JSON.parse(readFileSync(new URL('./fixtures/bangboo.animator.json', import.meta.url), 'utf8'));
const gia = Uint8Array.from(Buffer.from(j.gia, 'base64'));
function buildScene(yaws) {
  const ed = new Editor();
  ed.importGia(gia, 'b.gia');
  const p = ed.project;
  p.clips = []; p.constraints = []; p.exportConfig.slots = [];
  p.settings.globalOffset = [1.5, 0, -2]; // pivot away from the world origin
  const objs = p.nodes.filter((n) => n.type === 'object');
  const [A, B, C, D] = objs; // A standalone, B standalone rotated, C/D bone-driven
  for (const o of objs) { o.parent = null; }
  A.pos = [0.8, 0.1, 0.3]; A.rot = [0, 0, 0, 1];
  B.pos = [-0.6, 0.4, 0.2]; B.rot = quat.fromEulerDeg([0, 20, 0]); B.correction = [0, 0, 15];
  const root = createNode(p, 'bone', { name: 'root', pos: [0.2, 0, -0.5], rot: quat.fromEulerDeg([0, 30, 0]), length: 0.3 });
  const child = createNode(p, 'bone', { name: 'child', parent: root.id, pos: [0, 0.3, 0], rot: quat.fromEulerDeg([25, 0, 0]), length: 0.2 });
  C.parent = child.id; C.pos = [0.1, 0.2, 0]; C.rot = quat.fromEulerDeg([0, 0, 40]); C.correction = [10, 0, 0];
  D.parent = root.id; D.pos = [0, 0, 0.4]; D.rot = [0, 0, 0, 1];
  const clip = createClip(p, 'Walk', 1);
  p.activeClipId = clip.id;
  insertKey(clip, A.id, 'pos', 0, A.pos); insertKey(clip, A.id, 'pos', 1, v3.add(A.pos, [0.5, 0.2, 0]));
  insertKey(clip, root.id, 'rot', 0, root.rot); insertKey(clip, root.id, 'rot', 1, quat.fromEulerDeg([0, 30 + 80, 0]));
  insertKey(clip, child.id, 'rot', 0, child.rot); insertKey(clip, child.id, 'rot', 0.5, quat.fromEulerDeg([25, 0, 35])); insertKey(clip, child.id, 'rot', 1, child.rot);
  p.exportConfig.slots = yaws.map((y) => ({ clipId: clip.id, name: `Walk ${y}`, outputYaw: y }));
  p.exportConfig.initialSlot = 0;
  ed.history.reset(ed.snapshotState());
  return { ed, p, clip, objs: [A, B, C, D] };
}

function run(yaws, label) {
  const { ed, p, clip, objs } = buildScene(yaws);
  const pivot = exportPivot(p);
  const base = exportPlacement(p); // resting placement as written (turned by the reference slot's rotation)
  const refYaw = referenceYaw(p);
  const { bytes } = exportGia(p, gia);
  const out = collectObjects(parseGia(bytes));
  check(`${label}: pivot is the global position offset`, v3.dist(pivot, [1.5, 0, -2]) < 1e-9);
  yaws.forEach((yaw, si) => {
    const R = outputRotation(yaw);
    let poseOk = true, count = 0, maxP = 0, maxR = 0;
    const rebuilt = new Map(); // nodeId → [{t, pos, rot}]
    for (const node of objs) {
      const o = out.find((x) => x.guid === node.guid);
      const dev = o.motionDevices[si];
      if (!dev) {
        // a static piece in a slot that shares the resting rotation simply rests there
        const expected = rotateAboutPivot(evaluatePose(p, clip.id, 0).world.get(node.id), R, pivot);
        check(`${label} ${yaw}°: ${node.name} has no device but rests at its rotated pose`, yaw === refYaw && v3.dist(base.get(node.id).pos, expected.pos) < 1e-6 && ang(base.get(node.id).rot, expected.rot) < 1e-4);
        rebuilt.set(node.id, [{ t: 0, ...base.get(node.id) }]);
        continue;
      }
      let t = 0; const list = [];
      dev.points.forEach((pt, i) => {
        // a leading minimum-duration point is the frame-0 snap (time 0)
        if (!(i === 0 && dev.points.length > 1 && pt.duration <= 0.0300001)) t += pt.duration;
        const tt = Math.min(t, clip.duration);
        const expected = rotateAboutPivot(evaluatePose(p, clip.id, tt).world.get(node.id), R, pivot);
        const got = { pos: v3.add(base.get(node.id).pos, gameToDisplayPos(pt.pos)), rot: gameEulerToDisplayQuat(pt.rot) };
        const dp = v3.dist(got.pos, expected.pos), dr = ang(got.rot, expected.rot);
        maxP = Math.max(maxP, dp); maxR = Math.max(maxR, dr);
        if (dp > 0.01 || dr > 1.0) poseOk = false;
        list.push({ t: tt, ...got }); count++;
      });
      rebuilt.set(node.id, list);
    }
    check(`${label} ${yaw}°: every waypoint = evaluated pose rotated about the pivot (${count} points)`, poseOk, `max Δpos ${maxP.toExponential(2)} Δrot ${maxR.toFixed(3)}°`);
    // spacing between pieces at the end of the clip is unchanged by the rotation
    const endPose = (id) => rebuilt.get(id)[rebuilt.get(id).length - 1];
    const ref = (id) => evaluatePose(p, clip.id, clip.duration).world.get(id);
    let spacingOk = true, turnedOk = true, orientOk = true;
    for (let i = 0; i < objs.length; i++) for (let k = i + 1; k < objs.length; k++) {
      const d1 = v3.dist(endPose(objs[i].id).pos, endPose(objs[k].id).pos), d0 = v3.dist(ref(objs[i].id).pos, ref(objs[k].id).pos);
      if (Math.abs(d1 - d0) > 0.01) spacingOk = false;
    }
    for (const node of objs) {
      const e = endPose(node.id), r = ref(node.id);
      const offPivot = v3.dist(r.pos, pivot) > 0.05;
      if (yaw % 360 && offPivot && v3.dist(e.pos, r.pos) < 0.01) turnedOk = false; // stayed in place → wrong
      if (Math.abs(ang(e.rot, r.rot) - Math.abs(((yaw % 360) + 360) % 360 > 180 ? 360 - ((yaw % 360) + 360) % 360 : ((yaw % 360) + 360) % 360)) > 1.0) orientOk = false;
    }
    check(`${label} ${yaw}°: spacing between pieces preserved`, spacingOk);
    check(`${label} ${yaw}°: pieces away from the pivot moved with the arrangement`, turnedOk);
    check(`${label} ${yaw}°: every orientation turned by exactly the output rotation`, orientOk);
    // preview matches the file
    ed.setExportPreview(si); ed.setTime(clip.duration);
    const dw = ed.displayWorld();
    let previewOk = true;
    for (const node of objs) { const e = endPose(node.id), w = dw.get(node.id); if (v3.dist(e.pos, w.pos) > 0.01 || ang(e.rot, w.rot) > 1.0) previewOk = false; }
    check(`${label} ${yaw}°: viewport preview matches the exported arrangement`, previewOk);
    ed.setExportPreview(null);
  });
  // re-import: the reconstructed clips reproduce the rotated poses
  const re = importGia(bytes, 'r.gia').project;
  let rtOk = true;
  yaws.forEach((yaw, si) => {
    const R = outputRotation(yaw);
    const rc = re.clips[si];
    for (const node of objs) {
      const rn = re.nodes.find((n) => n.guid === node.guid);
      const w = evaluatePose(re, rc.id, rc.duration).world.get(rn.id);
      const expected = rotateAboutPivot(evaluatePose(p, clip.id, clip.duration).world.get(node.id), R, pivot);
      if (v3.dist(w.pos, expected.pos) > 0.01 || ang(w.rot, expected.rot) > 1.0) rtOk = false;
    }
  });
  check(`${label}: re-imported file reproduces every slot's rotated poses`, rtOk);
  // placement itself is never rotated (shared by all slots)
  const A = objs[0], oA = out.find((x) => x.guid === A.guid);
  check(`${label}: placement = frame-0 pose turned by the reference slot's rotation (${refYaw}°)`, v3.dist(gameToDisplayPos(oA.transform.position), rotateAboutPivot(exportBasePose(p).get(A.id), outputRotation(refYaw), pivot).pos) < 1e-6);
}

run([0, 90, 180, 270, 29.38], 'multi-slot');
run([45], '45°');

// editing with the preview on still edits the true pose
{
  const { ed, p, objs } = buildScene([90]);
  ed.setExportPreview(0); ed.setTime(0);
  const A = objs[0];
  const before = evaluatePose(p, p.activeClipId, 0).world.get(A.id).pos;
  const shown = ed.displayWorld().get(A.id);
  ed.setNodeWorld(A.id, ed.removePathOffset({ pos: v3.add(shown.pos, [0.1, 0, 0]), rot: shown.rot }, ed.displayOffset()), { commit: true });
  const after = evaluatePose(p, p.activeClipId, 0).world.get(A.id).pos;
  const R = outputRotation(90);
  check('preview: moving a piece by +0.1 on screen moves it by the un-rotated delta in the project', v3.dist(v3.sub(after, before), quat.rotate(quat.conj(R), [0.1, 0, 0])) < 1e-6);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
