// Path point compression for Miliastra's Linear Motion Devices. The game
// advertises 50 points per path, but its limit check is unreliable at exactly
// 50, so the editor treats MAX_PATH_POINTS = 49 as the safe maximum: 1–49
// points export normally, 50 or more must be compressed (never exported).
//
// A path is a list of points { pos, rot?, duration } where `duration` is the
// travel time from the previous point (the device interpolates position
// linearly and rotation by shortest arc at constant speed per segment). A
// point is redundant when the motion it describes is already reproduced by
// the straight segment between its retained neighbours AT THE SAME TIMES: the
// error of dropping it is measured for every original sample it used to cover
// as the distance (and rotation angle) between the sample and the interpolated
// pose on the merged segment at the sample's time. Interpolating by time, not
// by arc length, means timing is part of the error: a speed change, a pause or
// a direction/orientation change scores a large error and survives, while
// collinear, constant-speed and near-duplicate samples (typical of baked
// animation) score ~0 and go first. Points are removed greedily, least error
// first, until the target count is reached and the next removal would exceed
// the tolerance. Durations of removed points merge into the retained segment,
// so the total duration never changes. The first and last points, and points
// flagged `snap` / `keep`, are never removed.
import { v3, quat } from '../core/math.js';

export const MAX_PATH_POINTS = 49; // safe maximum (the in-game 50-point limit is bugged)
export const GAME_PATH_POINTS = 50; // what the game reports as its limit
// Compression that needs more than this deviation from the original motion is
// reported as unsafe instead of silently applied (metres / degrees).
export const ACCEPTABLE_ERROR = { pos: 0.05, rot: 10 };
// Tolerances for manual simplification (metres / degrees)
export const SIMPLIFY_PRESETS = { fine: { pos: 0.005, rot: 0.5 }, normal: { pos: 0.02, rot: 2 }, coarse: { pos: 0.05, rot: 5 } };

const ID = [0, 0, 0, 1];

// Compress a path to at most `maxPoints` points and/or within `tolerance`.
// Returns { points, before, after, maxError: { pos, rot }, reached, ok, removed }.
//   reached: the count target was met; ok: reached AND every removal stayed within `acceptable`.
export function compressPath(points, { maxPoints = Infinity, tolerance = { pos: 0, rot: 0 }, acceptable = ACCEPTABLE_ERROR } = {}) {
  const n = points.length;
  const before = n;
  if (n <= 2) return { points: points.map((p) => ({ ...p })), before, after: n, maxError: { pos: 0, rot: 0 }, reached: n <= maxPoints, ok: n <= maxPoints, removed: 0 };
  const T = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += Math.max(0, points[i].duration || 0); T[i] = acc; }
  const rot = (i) => points[i].rot || ID;
  const kept = new Array(n).fill(true);
  const protectedPt = (i) => i === 0 || i === n - 1 || !!points[i].snap || !!points[i].keep;
  const prevKept = (i) => { let j = i - 1; while (j >= 0 && !kept[j]) j--; return j; };
  const nextKept = (i) => { let j = i + 1; while (j < n && !kept[j]) j++; return j; };
  // error of the segment a→b against every original sample strictly between them
  const segmentError = (a, b) => {
    const span = T[b] - T[a];
    // a merged segment may not swallow more than 150° of the rotation the samples between
    // its ends actually perform: a device segment cannot express a turn direction past
    // ~180°, and whole revolutions would vanish. Never a candidate, whatever the error.
    if (points[a].rot || points[b].rot) {
      let arc = 0;
      for (let j = a; j < b && arc <= 150 * Math.PI / 180; j++) arc += quat.angle(rot(j), rot(j + 1));
      if (arc > 150 * Math.PI / 180) return { pos: Infinity, rot: Infinity };
    }
    let ep = 0, er = 0;
    for (let j = a + 1; j < b; j++) {
      const u = span > 1e-9 ? (T[j] - T[a]) / span : 1;
      const p = v3.lerp(points[a].pos, points[b].pos, u);
      ep = Math.max(ep, v3.dist(points[j].pos, p));
      if (points[j].rot || points[a].rot || points[b].rot) er = Math.max(er, quat.angle(rot(j), quat.slerp(rot(a), rot(b), u)) * 180 / Math.PI);
    }
    return { pos: ep, rot: er };
  };
  // ranking scale: the acceptable error, or the tolerance when the caller accepts anything
  const scale = { pos: Math.max(1e-9, Number.isFinite(acceptable.pos) ? acceptable.pos : tolerance.pos || 1), rot: Math.max(1e-9, Number.isFinite(acceptable.rot) ? acceptable.rot : tolerance.rot || 1) };
  const score = (e) => Math.max(e.pos / scale.pos, e.rot / scale.rot);
  const errors = new Array(n).fill(null);
  const refresh = (i) => { errors[i] = (!kept[i] || protectedPt(i)) ? null : segmentError(prevKept(i), nextKept(i)); };
  for (let i = 0; i < n; i++) refresh(i);
  let count = n, removed = 0;
  const maxError = { pos: 0, rot: 0 };
  for (;;) {
    let best = -1, bestScore = Infinity;
    for (let i = 1; i < n - 1; i++) { const e = errors[i]; if (!e) continue; const s = score(e); if (s < bestScore) { bestScore = s; best = i; } }
    if (best < 0) break;
    const e = errors[best];
    const withinTol = e.pos <= tolerance.pos + 1e-12 && e.rot <= tolerance.rot + 1e-9;
    if (count <= maxPoints && !withinTol) break;
    kept[best] = false; errors[best] = null; count--; removed++;
    maxError.pos = Math.max(maxError.pos, e.pos); maxError.rot = Math.max(maxError.rot, e.rot);
    refresh(prevKept(best)); refresh(nextKept(best));
  }
  const out = [];
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!kept[i]) continue;
    const duration = last < 0 ? Math.max(0, points[i].duration || 0) : T[i] - T[last];
    out.push({ ...points[i], duration });
    last = i;
  }
  const reached = count <= maxPoints;
  return { points: out, before, after: out.length, maxError, reached, ok: reached && maxError.pos <= acceptable.pos + 1e-9 && maxError.rot <= acceptable.rot + 1e-9, removed };
}

// Simplify a plain polyline ([x,y,z] points travelled at constant speed): keep
// every point whose removal would move the path by more than `tolerance` metres.
export function simplifyPolyline(pts, tolerance, { maxPoints = Infinity } = {}) {
  if (pts.length <= 2) return { points: pts.map((p) => p.slice()), before: pts.length, after: pts.length, maxError: { pos: 0, rot: 0 }, ok: true, reached: pts.length <= maxPoints };
  const path = pts.map((p, i) => ({ pos: p, duration: i ? Math.max(1e-6, v3.dist(pts[i - 1], p)) : 0 }));
  const r = compressPath(path, { maxPoints, tolerance: { pos: tolerance, rot: 0 }, acceptable: { pos: Infinity, rot: Infinity } });
  return { ...r, points: r.points.map((p) => p.pos.slice()) };
}
