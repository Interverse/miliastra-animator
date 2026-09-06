// FABRIK inverse kinematics with pole targets, operating on bone chains of
// the scene model. A constraint:
//   { id, name, boneId (chain tip), targetId, poleId, chainLength, enabled, influence, iterations }
// The chain runs from the tip bone up `chainLength` bones. Joint positions
// are the bone heads plus the tip's tail (end effector).
import { v3, quat, xf } from '../core/math.js';
import { getNode, localTransform } from '../scene/scene.js';

export function createConstraint(project, boneId, targetId, opts = {}) {
  project.counter = (project.counter || 0) + 1;
  const k = {
    id: `k${project.counter}`,
    name: opts.name || 'IK',
    boneId, targetId, poleId: opts.poleId ?? null,
    chainLength: opts.chainLength ?? 2,
    enabled: true, influence: 1, iterations: 12,
  };
  project.constraints.push(k);
  return k;
}

// bones of the chain from root to tip
export function chainBones(project, k) {
  const chain = [];
  let cur = getNode(project, k.boneId);
  let n = Math.max(1, k.chainLength | 0);
  while (cur && cur.type === 'bone' && n-- > 0) {
    chain.unshift(cur);
    cur = cur.parent ? getNode(project, cur.parent) : null;
  }
  return chain;
}

function fabrik(points, lengths, target, iterations) {
  const n = points.length - 1;
  const root = points[0].slice();
  const total = lengths.reduce((a, b) => a + b, 0);
  if (v3.dist(root, target) >= total) {
    // unreachable: stretch toward target
    const dir = v3.norm(v3.sub(target, root));
    for (let i = 0; i < n; i++) points[i + 1] = v3.add(points[i], v3.scale(dir, lengths[i]));
    return points;
  }
  for (let it = 0; it < iterations; it++) {
    if (v3.dist(points[n], target) < 1e-4) break;
    points[n] = target.slice();
    for (let i = n - 1; i >= 0; i--) {
      const d = v3.norm(v3.sub(points[i], points[i + 1]));
      points[i] = v3.add(points[i + 1], v3.scale(d, lengths[i]));
    }
    points[0] = root.slice();
    for (let i = 0; i < n; i++) {
      const d = v3.norm(v3.sub(points[i + 1], points[i]));
      points[i + 1] = v3.add(points[i], v3.scale(d, lengths[i]));
    }
  }
  return points;
}

// Rotate intermediate joints rigidly about the root→end axis so they face the pole.
function applyPole(points, pole) {
  const n = points.length - 1;
  if (n < 2) return;
  const axis = v3.norm(v3.sub(points[n], points[0]));
  if (v3.len(axis) < 1e-9) return;
  const radial = (p) => { const v = v3.sub(p, points[0]); return v3.sub(v, v3.scale(axis, v3.dot(v, axis))); };
  let avg = [0, 0, 0];
  for (let i = 1; i < n; i++) avg = v3.add(avg, radial(points[i]));
  const rp = radial(pole);
  if (v3.len(avg) < 1e-6 || v3.len(rp) < 1e-6) return;
  const a = v3.norm(avg), b = v3.norm(rp);
  const ang = Math.atan2(v3.dot(v3.cross(a, b), axis), v3.dot(a, b));
  const q = quat.axisAngle(axis, ang);
  for (let i = 1; i < n; i++) points[i] = v3.add(points[0], quat.rotate(q, v3.sub(points[i], points[0])));
}

// Solve one constraint. `poses` holds the current local overrides (mutated:
// chain bones get new rot), `world` is the current world map (recomputed by
// the caller afterwards).
export function solveConstraint(project, k, poses, world) {
  const chain = chainBones(project, k);
  const target = getNode(project, k.targetId);
  if (!chain.length || !target || !world.get(target.id)) return false;
  const tip = chain[chain.length - 1];
  const points = chain.map((b) => world.get(b.id).pos.slice());
  const tipW = world.get(tip.id);
  points.push(v3.add(tipW.pos, quat.rotate(tipW.rot, [0, tip.length || 0.25, 0])));
  const lengths = [];
  for (let i = 0; i < points.length - 1; i++) lengths.push(Math.max(1e-4, v3.dist(points[i], points[i + 1])));
  const fkPoints = points.map((p) => p.slice());
  fabrik(points, lengths, world.get(target.id).pos, k.iterations || 12);
  const pole = k.poleId ? getNode(project, k.poleId) : null;
  if (pole && world.get(pole.id)) applyPole(points, world.get(pole.id).pos);
  // convert positions → bone rotations, root to tip
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const infl = Math.max(0, Math.min(1, k.influence ?? 1));
  let parentW = chain[0].parent ? world.get(chain[0].parent) : { pos: project.settings?.globalOffset || [0, 0, 0], rot: [0, 0, 0, 1] };
  if (!parentW) parentW = xf.identity();
  for (let i = 0; i < chain.length; i++) {
    const bone = chain[i];
    const local = localTransform(bone, poses.get(bone.id));
    const w = xf.compose(parentW, local);
    const cur = quat.rotate(w.rot, [0, 1, 0]);
    const desired = v3.norm(v3.sub(points[i + 1], points[i]));
    let newRot = w.rot;
    if (v3.len(desired) > 1e-9) newRot = quat.norm(quat.mul(quat.fromUnitVectors(cur, desired), w.rot));
    let localRot = quat.norm(quat.mul(quat.conj(parentW.rot), newRot));
    if (infl < 1) localRot = quat.slerp(local.rot, localRot, infl);
    const prev = poses.get(bone.id) || {};
    // the solved rotation is an effective local rotation; strip a frozen basis for the pose store
    poses.set(bone.id, { ...prev, rot: bone.basis ? quat.norm(quat.mul(quat.conj(bone.basis.rot), localRot)) : localRot });
    parentW = xf.compose(parentW, { pos: local.pos, rot: localRot });
  }
  return true;
}

export function constraintIssues(project, k) {
  const issues = [];
  const bone = getNode(project, k.boneId);
  if (!bone || bone.type !== 'bone') issues.push('missingBone');
  const target = getNode(project, k.targetId);
  if (!target) issues.push('missingTarget');
  if (k.poleId && !getNode(project, k.poleId)) issues.push('missingPole');
  const chain = chainBones(project, k);
  if (chain.length < (k.chainLength | 0) && chain.length < 1) issues.push('shortChain');
  if (target && chain.some((b) => b.id === target.id)) issues.push('targetInChain');
  if (target && bone && chain.length) {
    // target inside the chain subtree → circular dependency
    let cur = target;
    let guard = 0;
    while (cur && guard++ < 1000) {
      if (chain.some((b) => b.id === cur.id)) { issues.push('targetInChain'); break; }
      cur = cur.parent ? getNode(project, cur.parent) : null;
    }
  }
  return [...new Set(issues)];
}
