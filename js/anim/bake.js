// Bake a clip into per-object waypoint lists suitable for Linear Motion
// Devices. Every object's world trajectory (keys + parents + IK + constraints)
// is sampled and simplified: an interval is exported as ONE straight,
// constant-speed segment whenever the sampled motion stays within tolerance
// of linear position / rotation interpolation; otherwise it is split at the
// point of largest deviation (snapped to an authored key time when one is
// nearby) until every segment is either linear or at the minimum duration.
import { v3, quat } from '../core/math.js';
import { evaluatePose, restWorld } from './evaluate.js';
import { keyTimes, clipEnd } from './clips.js';
import { MIN_KEY_SPACING } from './clips.js';

export const PRECISION = {
  low: { pos: 0.01, rot: 1.5 },
  normal: { pos: 0.003, rot: 0.5 },
  high: { pos: 0.001, rot: 0.2 },
};
export const MIN_SEGMENT = MIN_KEY_SPACING;

export function bakeClip(project, clip, { precision = 'normal', objectIds = null, restPose = null } = {}) {
  const tol = PRECISION[precision] || PRECISION.normal;
  const rotTol = tol.rot * Math.PI / 180;
  const duration = Math.max(MIN_SEGMENT, clipEnd(clip));
  const objects = project.nodes.filter((n) => n.type === 'object' && (!objectIds || objectIds.has(n.id)));
  const rest = restPose || restWorld(project);
  const cache = new Map();
  const sample = (t) => {
    const key = Math.round(t * 1e6);
    let s = cache.get(key);
    if (!s) { s = evaluatePose(project, clip.id, t).world; cache.set(key, s); }
    return s;
  };
  const times = keyTimes(clip);
  const warnings = [];
  const result = new Map();

  for (const obj of objects) {
    const P = (t) => sample(t).get(obj.id);
    const r0 = rest.get(obj.id);
    // does the object move at all?
    const probe = [0, 0.25, 0.5, 0.75, 1].map((u) => P(u * duration));
    const moves = probe.some((w) => v3.dist(w.pos, r0.pos) > tol.pos * 0.5 || quat.angle(w.rot, r0.rot) > rotTol * 0.5) || times.length > 0 && probeKeys(times, P, r0, tol, rotTol);
    if (!moves) { result.set(obj.id, { moves: false, points: [] }); continue; }

    const segments = [];
    const subdivide = (t0, t1, depth) => {
      const a = P(t0), b = P(t1);
      const span = t1 - t0;
      const n = Math.max(4, Math.min(48, Math.ceil(span / 0.02)));
      let worst = 0, worstT = (t0 + t1) / 2;
      for (let i = 1; i < n; i++) {
        const u = i / n, t = t0 + span * u;
        const w = P(t);
        const ep = v3.dist(w.pos, v3.lerp(a.pos, b.pos, u)) / tol.pos;
        const er = quat.angle(w.rot, quat.slerp(a.rot, b.rot, u)) / rotTol;
        const e = Math.max(ep, er);
        if (e > worst) { worst = e; worstT = t; }
      }
      if (worst <= 1 || span < 2 * MIN_SEGMENT || depth > 14) {
        if (worst > 1) warnings.push({ key: 'bake.tooFine', nodeId: obj.id, t: t0 });
        segments.push({ t0, t1, pos: b.pos, rot: b.rot });
        return;
      }
      // snap the split to a nearby authored key time
      let split = worstT;
      const step = span / n;
      for (const kt of times) if (kt > t0 + 1e-6 && kt < t1 - 1e-6 && Math.abs(kt - worstT) <= step * 1.01) { split = kt; break; }
      split = Math.max(t0 + MIN_SEGMENT, Math.min(t1 - MIN_SEGMENT, split));
      subdivide(t0, split, depth + 1);
      subdivide(split, t1, depth + 1);
    };
    subdivide(0, duration, 0);

    const points = [];
    const w0 = P(0);
    const startsOff = v3.dist(w0.pos, r0.pos) > tol.pos * 0.5 || quat.angle(w0.rot, r0.rot) > rotTol * 0.5;
    if (startsOff) points.push({ t: 0, pos: w0.pos, rot: w0.rot, duration: MIN_SEGMENT, snap: true });
    for (const s of segments) points.push({ t: s.t1, pos: s.pos, rot: s.rot, duration: Math.max(MIN_SEGMENT, s.t1 - s.t0) });
    result.set(obj.id, { moves: true, points });
  }
  return { points: result, warnings, duration, frame0: sample(0) };
}

function probeKeys(times, P, r0, tol, rotTol) {
  for (const t of times) {
    const w = P(t);
    if (v3.dist(w.pos, r0.pos) > tol.pos * 0.5 || quat.angle(w.rot, r0.rot) > rotTol * 0.5) return true;
  }
  return false;
}
