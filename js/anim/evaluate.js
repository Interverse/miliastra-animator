// Pose evaluation: keyframe tracks → IK → world transforms.
import { worldTransforms, getNode } from '../scene/scene.js';
import { evaluateClip, getClip } from './clips.js';
import { solveConstraint } from './ik.js';

// Returns { poses: Map id → {pos?, rot?} (local overrides), world: Map id → {pos, rot} }
// `overrides` (Map id → {pos?, rot?}) are unkeyed pose edits made at the playhead;
// they win over the keyframe tracks and are applied before IK so constraints
// still see the edited FK pose.
export function evaluatePose(project, clipId, time, { ik = true, overrides = null } = {}) {
  const clip = clipId ? getClip(project, clipId) : null;
  const poses = clip ? evaluateClip(clip, time) : new Map();
  if (overrides) for (const [id, o] of overrides) {
    const p = poses.get(id) || {};
    poses.set(id, { ...p, ...(o.pos ? { pos: o.pos } : {}), ...(o.rot ? { rot: o.rot, rotE: o.rotE || undefined } : {}) });
  }
  // Root Motion off: the clip plays in place — the root node's horizontal travel is
  // held at its first key (vertical motion stays). The keys themselves are untouched.
  if (clip && clip.rootMotion === false) {
    const rid = rootMotionNode(project, clip);
    const tr = rid && clip.tracks[rid];
    const p = tr && tr.pos.length ? poses.get(rid) : null;
    if (p?.pos) { const f = tr.pos[0].v; p.pos = [f[0], p.pos[1], f[2]]; }
  }
  let world = worldTransforms(project, poses);
  if (ik) {
    for (const k of project.constraints) {
      if (!k.enabled) continue;
      if (solveConstraint(project, k, poses, world)) world = worldTransforms(project, poses);
    }
  }
  return { poses, world };
}

// The node whose position track carries the clip's root motion: the clip's
// declared root (retargeted hips, baked Locomotion bone) or, failing that, the
// shallowest node with position keys. Null when the clip has no travel data.
export function rootMotionNode(project, clip) {
  if (!clip) return null;
  const hasPos = (id) => clip.tracks[id]?.pos?.length > 0;
  if (clip.rootNodeId && hasPos(clip.rootNodeId) && getNode(project, clip.rootNodeId)) return clip.rootNodeId;
  let best = null, bestDepth = Infinity;
  for (const id of Object.keys(clip.tracks)) {
    if (!hasPos(id)) continue;
    let d = 0, cur = getNode(project, id);
    if (!cur) continue;
    while (cur && cur.parent && d < 1000) { d++; cur = getNode(project, cur.parent); }
    if (d < bestDepth) { bestDepth = d; best = id; }
  }
  return best;
}
// Does the clip contain root translation that the Root Motion toggle can control?
export function clipHasRootMotion(project, clip) {
  const rid = rootMotionNode(project, clip);
  if (!rid) return false;
  const keys = clip.tracks[rid].pos;
  const f = keys[0].v;
  return keys.some((k) => Math.hypot(k.v[0] - f[0], k.v[2] - f[2]) > 1e-6);
}

// Rest pose (no animation, no IK) — what the exported file's transform holds.
export function restWorld(project) {
  return worldTransforms(project, null);
}
