// Pose evaluation: keyframe tracks → IK → world transforms.
import { worldTransforms } from '../scene/scene.js';
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
    poses.set(id, { ...p, ...(o.pos ? { pos: o.pos } : {}), ...(o.rot ? { rot: o.rot } : {}) });
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

// Rest pose (no animation, no IK) — what the exported file's transform holds.
export function restWorld(project) {
  return worldTransforms(project, null);
}
