// Experimental Auto-Rig:  node tools/test-autorig.mjs
// Humanoid detection on the supplied Pantalone model, a synthetic nameless
// quadruped, apply as one undo step preserving world transforms, undo exactness.
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { proposeRig, classify, objectFeatures } from '../js/rig/autorig.js';
import { createNode, worldTransforms, getNode } from '../js/scene/scene.js';
import { createProject } from '../js/scene/scene.js';
import { exportGia } from '../js/gia/gia-export.js';
import { quat, v3 } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const ang = (a, b) => quat.angle(a, b) * 180 / Math.PI;

// ---------- humanoid (Pantalone) ----------
{
  const ed = new Editor();
  ed.importGia(new Uint8Array(readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url))), 'Pantalone.gia');
  const p = ed.project;
  const before = JSON.stringify(ed.snapshotState());
  const worldBefore = worldTransforms(p, null);
  const giaBefore = Buffer.from(exportGia(p, new Uint8Array(readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url)))).bytes);
  const feats = objectFeatures(p);
  check('features: bounds per object from display parts', feats.length === 16 && feats.every((f) => f.size.every((s) => s > 0)));
  const cls = classify(feats);
  check('classified as humanoid with usable confidence', cls.type === 'humanoid' && cls.confidence > 0.5, `${cls.type} ${cls.confidence.toFixed(2)} ${JSON.stringify(cls.scores)}`);
  const prop = ed.proposeAutoRig({ ik: true });
  const keys = prop.bones.map((b) => b.key);
  const expect = ['hips', 'chest', 'neck', 'head', 'upperArmL', 'forearmL', 'handL', 'upperArmR', 'forearmR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];
  check('humanoid regions found', expect.every((k) => keys.includes(k)), `missing: ${expect.filter((k) => !keys.includes(k)).join(',') || 'none'}`);
  const assigned = new Set(prop.bones.flatMap((b) => b.objects));
  check('every object assigned to a bone', assigned.size === 16 && prop.unassigned.length === 0, `unassigned ${prop.unassigned.length}`);
  const nameOf = (id) => getNode(p, id).name;
  const boneObj = (k) => prop.bones.find((b) => b.key === k).objects.map(nameOf).join();
  check('name hints line up with regions', boneObj('head') === 'head' && boneObj('handL').includes('hand') && boneObj('thighR').includes('thigh') && boneObj('footL').includes('foot'));
  const thigh = prop.bones.find((b) => b.key === 'thighL'), shin = prop.bones.find((b) => b.key === 'shinL');
  check('leg bones point downward and chain head-to-tail', thigh.tail[1] < thigh.head[1] && v3.dist(thigh.tail, shin.head) < 1e-9);
  check('hierarchy: shin → thigh → hips, hand → forearm → upper arm → shoulder → chest', shin.parentKey === 'thighL' && thigh.parentKey === 'hips' && prop.bones.find((b) => b.key === 'handL').parentKey === 'forearmL' && prop.bones.find((b) => b.key === 'upperArmL').parentKey === 'shoulderL');
  check('IK suggested for both legs and arms', prop.ik.length === 4);
  check('every bone carries a confidence', prop.bones.every((b) => b.confidence > 0 && b.confidence <= 1));
  // apply
  const undo0 = ed.history.undoStack.length;
  const created = ed.applyAutoRig(prop);
  check('apply creates bones, targets, poles and constraints', created.bones.length === prop.bones.length && created.targets.length === 4 && created.poles.length === 4 && created.constraints.length === 4);
  check('one undo step', ed.history.undoStack.length === undo0 + 1 && ed.history.undoLabel() === 'Auto-Rig');
  const worldAfter = worldTransforms(ed.project, null);
  let maxPos = 0, maxRot = 0;
  for (const o of ed.project.nodes.filter((n) => n.type === 'object')) { maxPos = Math.max(maxPos, v3.dist(worldAfter.get(o.id).pos, worldBefore.get(o.id).pos)); maxRot = Math.max(maxRot, ang(worldAfter.get(o.id).rot, worldBefore.get(o.id).rot)); }
  check('objects keep their world transforms (parented, not moved)', maxPos < 1e-6 && maxRot < 1e-4, `Δpos ${maxPos.toExponential(1)} Δrot ${maxRot.toExponential(1)}°`);
  check('all objects now parented to bones', ed.project.nodes.filter((n) => n.type === 'object').every((o) => getNode(ed.project, o.parent)?.type === 'bone'));
  const bonesByName = new Map(ed.project.nodes.filter((n) => n.type === 'bone').map((b) => [b.name, b]));
  const wa = worldAfter;
  const th = bonesByName.get('Thigh.L');
  const yAxis = quat.rotate(wa.get(th.id).rot, [0, 1, 0]);
  check('bone Y axis follows the limb direction', yAxis[1] < -0.8, yAxis.map((x) => x.toFixed(2)).join());
  const giaAfter = Buffer.from(exportGia(ed.project, new Uint8Array(readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url)))).bytes);
  check('export unchanged by an unanimated rig (bones/targets not exported)', Buffer.compare(giaBefore, giaAfter) === 0);
  ed.undo();
  check('undo restores the exact previous project', JSON.stringify(ed.snapshotState()) === before);
  ed.redo();
  check('redo restores the rig', ed.project.nodes.filter((n) => n.type === 'bone').length === prop.bones.length);
  // existing rig warning + FK-only proposal
  const again = ed.proposeAutoRig({});
  check('a rigged model reports its existing bones and proposes nothing new for parented objects', again.existingBones === prop.bones.length && again.bones.length === 0);
  const fk = proposeRig(p, { ik: false });
  check('IK is optional', fk.ik.length === 0);
}

// ---------- synthetic nameless quadruped ----------
{
  const p = createProject();
  const box = (name, pos, size) => { const n = createNode(p, 'object', { name, pos, rot: [0, 0, 0, 1], guid: Math.floor(Math.random() * 1e9), zoom: [1, 1, 1] }); n.decorations = [{ guid: 1, name: 'd', modelId: 999999, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: size, argb: 0xffffffff }]; return n; };
  box('o1', [0, 0.6, 0], [1.2, 0.5, 0.5]);          // body along X
  box('o2', [0.9, 0.9, 0], [0.4, 0.4, 0.35]);       // head (front, higher)
  box('o3', [-0.9, 0.7, 0], [0.5, 0.15, 0.15]);     // tail (rear)
  for (const [x, z] of [[0.45, 0.25], [0.45, -0.25], [-0.45, 0.25], [-0.45, -0.25]]) { box('u', [x, 0.3, z], [0.15, 0.3, 0.15]); box('l', [x, 0.05, z], [0.12, 0.25, 0.12]); }
  const feats = objectFeatures(p);
  const cls = classify(feats);
  check('nameless quadruped classified as quadruped', cls.type === 'quadruped', `${cls.type} ${JSON.stringify(cls.scores)}`);
  const prop = proposeRig(p, { ik: true });
  const keys = prop.bones.map((b) => b.key);
  check('quadruped regions: root, neck, head, tail, four legs', ['root', 'neck', 'head', 'tail', 'upperFrontL', 'upperFrontR', 'upperBackL', 'upperBackR', 'lowerFrontL', 'lowerBackR'].every((k) => keys.includes(k)), keys.join());
  check('head object assigned to the head bone at the front', prop.bones.find((b) => b.key === 'head').objects.length === 1 && getNode(p, prop.bones.find((b) => b.key === 'head').objects[0]).name === 'o2');
  check('four leg IK chains suggested', prop.ik.length === 4);
  check('no unassigned objects', prop.unassigned.length === 0);
}

// ---------- segmented / bird fall-backs ----------
{
  const p = createProject();
  const seg = (i) => { const n = createNode(p, 'object', { name: 's' + i, pos: [i * 0.5, 0, 0], guid: i + 1, zoom: [1, 1, 1] }); n.decorations = [{ guid: i, name: 'd', modelId: 1, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [0.4, 0.2, 0.2], argb: 0xffffffff }]; return n; };
  for (let i = 0; i < 5; i++) seg(i);
  const prop = proposeRig(p, {});
  check('a chain of segments becomes a bone chain', prop.type === 'segmented' && prop.bones.length === 5 && prop.bones[4].parentKey === 'seg4');
  const b = createProject();
  const mk = (name, pos, size) => { const n = createNode(b, 'object', { name, pos, guid: Math.floor(Math.random() * 1e9), zoom: [1, 1, 1] }); n.decorations = [{ guid: 1, name: 'd', modelId: 1, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: size, argb: 0xffffffff }]; return n; };
  mk('body', [0, 0.5, 0], [0.4, 0.3, 0.6]); mk('head', [0, 0.8, 0.4], [0.2, 0.2, 0.2]);
  mk('w', [0.8, 0.55, 0], [1.2, 0.05, 0.4]); mk('w', [-0.8, 0.55, 0], [1.2, 0.05, 0.4]);
  mk('leg', [0.1, 0.15, 0], [0.05, 0.3, 0.05]); mk('leg', [-0.1, 0.15, 0], [0.05, 0.3, 0.05]);
  const bp = proposeRig(b, { type: 'bird' });
  check('bird template: body, head, two wings, two legs', ['root', 'head', 'wingL', 'wingR', 'legL', 'legR'].every((k) => bp.bones.some((x) => x.key === k)));
  check('wings detected as the widest pair', classify(objectFeatures(b)).type === 'bird');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
