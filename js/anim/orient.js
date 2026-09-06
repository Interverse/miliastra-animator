// Whole-model orientation: headings, forward-direction detection and the rigid
// rotation of the complete assembly about the model pivot (the global offset).
import { v3, quat } from '../core/math.js';
import { worldTransforms } from '../scene/scene.js';
import { assignRoles } from '../retarget/bone-map.js';

// Forward directions in display space (Y up, right-handed): heading = atan2(x, z) in degrees.
export const FORWARDS = { '+Z': [0, 0, 1], '+X': [1, 0, 0], '-Z': [0, 0, -1], '-X': [-1, 0, 0] };
export const EDITOR_FORWARD = '+Z'; // convention shared with glTF / FBX / Mixamo rigs
export const headingOf = (dir) => Math.atan2(dir[0], dir[2]) * 180 / Math.PI;
export const headingName = (deg) => { const d = ((deg % 360) + 540) % 360 - 180; return Math.abs(d) <= 45 ? '+Z' : Math.abs(d - 90) <= 45 ? '+X' : Math.abs(d + 90) <= 45 ? '-X' : '-Z'; };
// yaw (about +Y) that turns heading `from` into heading `to`, in (-180, 180]
export const yawBetween = (from, to) => { let d = to - from; d = ((d % 360) + 540) % 360 - 180; return d === -180 ? 180 : d; };
export const yawQuat = (deg) => quat.axisAngle([0, 1, 0], deg * Math.PI / 180);

// Forward direction of a humanoid from its hips/thighs (or shoulders): the side
// vector runs right → left, forward = side × up. Returns { dir, heading, name } or null.
export function forwardFromSides(left, right) {
  if (!left || !right) return null;
  const side = v3.sub(left, right); side[1] = 0;
  if (v3.len(side) < 1e-6) return null;
  const dir = v3.norm(v3.cross(v3.norm(side), [0, 1, 0]));
  const heading = headingOf(dir);
  return { dir, heading, name: headingName(heading) };
}
// Forward of the project's rig (bones named by role), null when it cannot be told.
export function modelForward(project) {
  const bones = project.nodes.filter((n) => n.type === 'bone').map((b, i) => ({ id: b.id, name: b.name, parent: b.parent, depth: 0, index: i }));
  if (!bones.length) return null;
  const roles = assignRoles(bones);
  const world = worldTransforms(project, null);
  for (const [l, r] of [['thigh.L', 'thigh.R'], ['upperArm.L', 'upperArm.R'], ['shoulder.L', 'shoulder.R'], ['foot.L', 'foot.R']]) {
    if (roles[l] && roles[r]) { const f = forwardFromSides(world.get(roles[l].id)?.pos, world.get(roles[r].id)?.pos); if (f) return f; }
  }
  return null;
}
// Forward of an imported skeleton (retarget source) from its rest pose.
export function sourceForward(src, sourceRoles) {
  for (const [l, r] of [['thigh.L', 'thigh.R'], ['upperArm.L', 'upperArm.R'], ['shoulder.L', 'shoulder.R']]) {
    const li = sourceRoles?.[l], ri = sourceRoles?.[r];
    if (li == null || ri == null) continue;
    const f = forwardFromSides(src.bones[li]?.restWorld?.pos, src.bones[ri]?.restWorld?.pos);
    if (f) return f;
  }
  return null;
}
