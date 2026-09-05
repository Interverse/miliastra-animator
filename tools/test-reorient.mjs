// "Keep children" rotation mode: reorienting a node must leave every descendant's
// world transform unchanged in the rest pose and in every keyed pose, and undo
// must restore the exact previous state.   node tools/test-reorient.mjs
import { Editor } from '../js/ui/editor.js';
import { createNode, worldTransforms } from '../js/scene/scene.js';
import { createClip, insertKey } from '../js/anim/clips.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { quat, v3 } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const same = (a, b) => v3.dist(a.pos, b.pos) < 1e-6 && quat.angle(a.rot, b.rot) < 1e-6;

const ed = new Editor();
const p = ed.project;
const root = createNode(p, 'bone', { name: 'root', pos: [0.3, 1, 0], rot: quat.fromEulerDeg([10, 20, 30]), length: 0.4 });
const mid = createNode(p, 'bone', { name: 'mid', parent: root.id, pos: [0, 0.4, 0], rot: quat.fromEulerDeg([0, 0, 25]), length: 0.3 });
const tip = createNode(p, 'bone', { name: 'tip', parent: mid.id, pos: [0, 0.3, 0.05], rot: quat.fromEulerDeg([15, 0, 0]), length: 0.2 });
const obj = createNode(p, 'object', { name: 'obj', parent: mid.id, pos: [0.1, 0.2, 0], rot: quat.fromEulerDeg([0, 45, 0]), guid: 1, zoom: [0.1, 0.1, 0.1] });
obj.correction = [0, 0, 90];
const deep = createNode(p, 'proxy', { name: 'deep', parent: tip.id, pos: [0, 0.2, 0] });
const clip = createClip(p, 'A', 2);
p.activeClipId = clip.id;
insertKey(clip, mid.id, 'rot', 0, mid.rot); insertKey(clip, mid.id, 'rot', 1, quat.fromEulerDeg([0, 30, 60]));
insertKey(clip, obj.id, 'pos', 0, obj.pos); insertKey(clip, obj.id, 'pos', 1, [0.3, 0.1, -0.2]);
insertKey(clip, obj.id, 'rot', 1, quat.fromEulerDeg([20, 0, 0]));
insertKey(clip, tip.id, 'rot', 1, quat.fromEulerDeg([0, 0, -40]));
ed.history.reset(p);
const snapshot = JSON.stringify(p);

const worldsAt = (t) => evaluatePose(ed.project, clip.id, t).world; // always the live project (undo swaps it)
const before = { t0: worldsAt(0), t1: worldsAt(1), t05: worldsAt(0.5) };
const beforeMidLocal = ed.currentLocal(mid.id).rot;

ed.rotateMode = 'preserve';
const target = quat.norm(quat.mul(beforeMidLocal, quat.fromEulerDeg([0, 40, 0]))); // reorient mid by 40° about its local Y
ed.setNodeLocal(mid.id, { rot: target });

const midNow = ed.currentLocal(mid.id).rot;
check('bone takes the new orientation', quat.angle(midNow, target) < 1e-6, `${quat.angle(midNow, target)}`);
for (const [name, tt] of [['rest (t=0)', 0], ['keyed pose (t=1)', 1], ['interpolated (t=0.5)', 0.5]]) {
  const w = worldsAt(tt);
  const b = before[tt === 0 ? 't0' : tt === 1 ? 't1' : 't05'];
  check(`descendants unchanged at ${name}`, [tip, obj, deep].every((n) => same(w.get(n.id), b.get(n.id))),
    [tip, obj, deep].map((n) => `${n.name}: ${v3.dist(w.get(n.id).pos, b.get(n.id).pos).toExponential(1)}/${quat.angle(w.get(n.id).rot, b.get(n.id).rot).toExponential(1)}`).join(' '));
  check(`bone reoriented by 40° at ${name}`, Math.abs(quat.angle(w.get(mid.id).rot, b.get(mid.id).rot) - 40 * Math.PI / 180) < 1e-6);
}
check('correction untouched', obj.correction.join() === '0,0,90');
check('one undo step', ed.history.undoStack.length === 1 && ed.history.undoLabel() === 'Reorient (keep children)', ed.history.undoLabel());
ed.undo();
check('undo restores exact state', JSON.stringify(ed.project) === snapshot);
ed.redo();
check('redo reproduces corrected state', quat.angle(ed.currentLocal(mid.id).rot, target) < 1e-6 && [tip, obj, deep].every((n) => same(worldsAt(1).get(n.id), before.t1.get(n.id))));

// normal mode still rotates children (root has no keys, so its base rotation is what shows)
ed.undo();
ed.rotateMode = 'normal';
p.settings.autoKey = false;
ed.setNodeLocal(root.id, { rot: quat.mul(ed.currentLocal(root.id).rot, quat.fromEulerDeg([0, 40, 0])) });
check('normal mode moves children', !same(worldsAt(0).get(obj.id), before.t0.get(obj.id)));

// IK: reorienting the tip of an IK chain keeps children fixed even though IK re-aims the bone
ed.undo();
const ikT = createNode(ed.project, 'target', { name: 't', pos: [0.6, 1.9, 0.2] });
ed.project.constraints.push({ id: 'k1', name: 'IK', boneId: tip.id, targetId: ikT.id, poleId: null, chainLength: 2, enabled: true, influence: 1, iterations: 12 });
ed.history.reset(ed.project);
const ikBefore = worldsAt(0.5).get(deep.id);
const ikTipBefore = worldsAt(0.5).get(tip.id).rot;
ed.rotateMode = 'preserve';
ed.setNodeLocal(tip.id, { rot: quat.mul(ed.currentLocal(tip.id).rot, quat.fromEulerDeg([25, 60, 10])) });
const tipMoved = quat.angle(worldsAt(0.5).get(tip.id).rot, ikTipBefore) > 1e-3;
check('IK tip reorient keeps child fixed', same(worldsAt(0.5).get(deep.id), ikBefore), `${v3.dist(worldsAt(0.5).get(deep.id).pos, ikBefore.pos).toExponential(1)}`);
check('IK tip itself changed (twist survives IK)', tipMoved);

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
