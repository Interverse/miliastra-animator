// Display-only movement paths for previewing locomotion.
//   { id, name, kind: 'direction' | 'manual', direction: [x,y,z], velocity, duration,
//     points: [[x,y,z]…], loop, faceDirection, enabled }
// Directional paths move along `direction` at `velocity` for `duration`;
// manual paths pass through points at constant speed (`velocity`) or spread
// over `duration`.
import { v3, quat } from '../core/math.js';

export function createWaypath(project, kind = 'direction') {
  project.counter = (project.counter || 0) + 1;
  const wp = {
    id: `w${project.counter}`, name: kind === 'manual' ? 'Manual Path' : 'Directional Path', kind,
    direction: [0, 0, 1], velocity: 1, duration: 2, useVelocity: true, useDuration: true,
    points: [[0, 0, 0], [0, 0, 2]], loop: true, faceDirection: false, enabled: true,
  };
  project.waypaths.push(wp);
  return wp;
}

export function pathLength(wp) {
  if (wp.kind === 'direction') return effectiveDirectional(wp).distance;
  let l = 0;
  for (let i = 1; i < wp.points.length; i++) l += v3.dist(wp.points[i - 1], wp.points[i]);
  return l;
}

// Resolve velocity/duration/distance for a directional path: the user may
// give velocity, duration, or both.
export function effectiveDirectional(wp) {
  const dir = v3.norm(wp.direction);
  const vel = Math.max(0, wp.velocity || 0), dur = Math.max(0, wp.duration || 0);
  if (wp.useVelocity && wp.useDuration) return { dir, velocity: vel, duration: dur, distance: vel * dur };
  if (wp.useVelocity) return { dir, velocity: vel, duration: dur || 1, distance: vel * (dur || 1) };
  return { dir, velocity: dur ? (wp.distance || 2) / dur : 0, duration: dur || 1, distance: wp.distance || 2 };
}

export function pathDuration(wp) {
  if (wp.kind === 'direction') return effectiveDirectional(wp).duration;
  if (wp.useDuration && wp.duration > 0) return wp.duration;
  const v = wp.velocity > 0 ? wp.velocity : 1;
  return pathLength(wp) / v;
}

// Offset (and optional yaw) at time t: { pos: [x,y,z], yaw: radians }
export function evaluateWaypath(wp, t) {
  const dur = pathDuration(wp);
  if (dur <= 0) return { pos: [0, 0, 0], yaw: 0 };
  let u = t / dur;
  if (wp.loop) u = u - Math.floor(u); else u = Math.max(0, Math.min(1, u));
  if (wp.kind === 'direction') {
    const e = effectiveDirectional(wp);
    const pos = v3.scale(e.dir, e.distance * u);
    return { pos, yaw: yawOf(e.dir) };
  }
  const pts = wp.points;
  if (pts.length < 2) return { pos: pts[0] ? pts[0].slice() : [0, 0, 0], yaw: 0 };
  const total = pathLength(wp);
  let d = total * u;
  for (let i = 1; i < pts.length; i++) {
    const seg = v3.dist(pts[i - 1], pts[i]);
    if (d <= seg || i === pts.length - 1) {
      const k = seg > 1e-9 ? Math.min(1, d / seg) : 0;
      const dir = v3.norm(v3.sub(pts[i], pts[i - 1]));
      return { pos: v3.lerp(pts[i - 1], pts[i], k), yaw: yawOf(dir) };
    }
    d -= seg;
  }
  return { pos: pts[pts.length - 1].slice(), yaw: 0 };
}

export function yawOf(dir) {
  if (Math.abs(dir[0]) < 1e-9 && Math.abs(dir[2]) < 1e-9) return 0;
  return Math.atan2(dir[0], dir[2]);
}

// Keyframes for baking the path onto a root node: [{t, pos, rot(quat)}]
export function bakeWaypathKeys(wp) {
  const dur = pathDuration(wp);
  const keys = [];
  if (wp.kind === 'direction') {
    const e = effectiveDirectional(wp);
    keys.push({ t: 0, pos: [0, 0, 0], rot: wp.faceDirection ? quat.axisAngle([0, 1, 0], yawOf(e.dir)) : [0, 0, 0, 1] });
    keys.push({ t: dur, pos: v3.scale(e.dir, e.distance), rot: wp.faceDirection ? quat.axisAngle([0, 1, 0], yawOf(e.dir)) : [0, 0, 0, 1] });
    return keys;
  }
  const total = pathLength(wp);
  let acc = 0;
  for (let i = 0; i < wp.points.length; i++) {
    if (i > 0) acc += v3.dist(wp.points[i - 1], wp.points[i]);
    const t = total > 0 ? (acc / total) * dur : 0;
    const dirIdx = Math.min(i + 1, wp.points.length - 1);
    const dir = v3.norm(v3.sub(wp.points[dirIdx], wp.points[Math.max(0, dirIdx - 1)]));
    keys.push({ t, pos: wp.points[i].slice(), rot: wp.faceDirection ? quat.axisAngle([0, 1, 0], yawOf(dir)) : [0, 0, 0, 1] });
  }
  return keys;
}
