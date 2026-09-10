// Animation curves: the per-component view of the clip tracks used by the Graph Editor,
// export baking and evaluation. There is ONE keyframe store (clip.tracks, see clips.js);
// this module only reads and edits it.
//
//   channel  = { id, nodeId, ch: 'pos'|'rot', comp: 0..2, unit: 'm'|'deg' }
//   point    = one component of one key: ref `${nodeId}|${ch}|${t}|${comp}`
//   tangents = key.h = { m: 'flat'|'auto'|'aligned'|'free', in: [sx,sy,sz], out: [sx,sy,sz] }
//              slopes in units per second (metres/s, degrees/s). Only used by 'ease' segments.
//              Keys without `h` behave as 'flat' (zero slope): a cubic Hermite with flat ends is
//              exactly the smoothstep the editor always used for "Ease in/out", so old projects
//              play back unchanged.
//
// Rotation channels are the authored, UNWRAPPED Euler angles (`key.e`, 450°, -720° …). Keys
// that only carry a quaternion (IK, imported data) get a continuous Euler chain derived from
// the previous key, never a shortest-arc wrap, so a curve from 0 to 720° rises through 720.
import { quat } from '../core/math.js';
import { keyRef } from './clips.js';

export const CHANNEL_DEFS = [
  { ch: 'pos', comps: ['X', 'Y', 'Z'], unit: 'm', labelKey: 'graph.position' },
  { ch: 'rot', comps: ['X', 'Y', 'Z'], unit: 'deg', labelKey: 'graph.rotation' },
];
export const HANDLE_MODES = ['auto', 'flat', 'aligned', 'free'];
export const channelId = (nodeId, ch, comp) => `${nodeId}|${ch}|${comp}`;
export const pointRef = (nodeId, ch, t, comp) => `${keyRef(nodeId, ch, t)}|${comp}`;
export const parsePointRef = (ref) => { const [nodeId, ch, ts, c] = ref.split('|'); return { nodeId, ch, t: Number(ts), comp: Number(c), keyRef: `${nodeId}|${ch}|${ts}` }; };
export const unitOf = (ch) => (ch === 'rot' ? 'deg' : 'm');

// ---------- Euler chain for rotation keys ----------
// Authored angles of every rotation key: `e` when present, otherwise the representation of
// the quaternion closest to the previous key's angles (continuous, multi-turn preserving).
export function trackEuler(keys, ref = null) {
  const out = [];
  let prev = ref;
  for (const k of keys) {
    const e = k.e ? k.e.slice() : quat.eulerNear(k.v, prev);
    out.push(e);
    prev = e;
  }
  return out;
}
// Write the derived chain into the keys so the track becomes Euler-authored (needed before a
// rotation value can be edited as a curve). Returns true when something was filled in.
export function ensureEuler(keys, ref = null) {
  if (keys.every((k) => k.e)) return false;
  const es = trackEuler(keys, ref);
  keys.forEach((k, i) => { if (!k.e) k.e = es[i]; });
  return true;
}
// scalar value of one key on one channel component
export function keyValue(key, ch, comp, eulerFallback = null) {
  if (ch === 'rot') return (key.e || eulerFallback || quat.toEulerDeg(key.v))[comp];
  return key.v[comp];
}
export function setKeyValue(key, ch, comp, value) {
  if (ch === 'rot') {
    if (!key.e) key.e = quat.toEulerDeg(key.v);
    key.e[comp] = value;
    key.v = quat.fromEulerDeg(key.e);
  } else key.v[comp] = value;
}

// ---------- tangents ----------
const values = (keys, ch, i, es) => (ch === 'rot' ? (es ? es[i] : keys[i].e || quat.toEulerDeg(keys[i].v)) : keys[i].v);
// Automatic slope at key i for component c: Catmull-Rom through the neighbours, clamped so the
// curve never overshoots (flat at local extrema and at the ends). Units per second.
export function autoSlope(keys, i, ch, comp, es = null) {
  const n = keys.length;
  if (n < 2 || i <= 0 || i >= n - 1) return 0;
  const v0 = values(keys, ch, i - 1, es)[comp], v1 = values(keys, ch, i, es)[comp], v2 = values(keys, ch, i + 1, es)[comp];
  const d0 = (v1 - v0) / Math.max(1e-9, keys[i].t - keys[i - 1].t);
  const d1 = (v2 - v1) / Math.max(1e-9, keys[i + 1].t - keys[i].t);
  if (d0 * d1 <= 0) return 0; // extremum or plateau: flat
  const m = (v2 - v0) / Math.max(1e-9, keys[i + 1].t - keys[i - 1].t);
  const lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
  return Math.sign(m) * Math.min(Math.abs(m), lim);
}
// {in, out} slopes of key i, component c, honouring its handle mode.
export function keySlopes(keys, i, ch, comp, es = null) {
  const k = keys[i];
  const h = k.h;
  const mode = h?.m || 'flat';
  if (mode === 'flat') return { in: 0, out: 0 };
  if (mode === 'auto') { const s = autoSlope(keys, i, ch, comp, es); return { in: s, out: s }; }
  const sin = h.in?.[comp] ?? 0, sout = h.out?.[comp] ?? 0;
  return mode === 'aligned' ? { in: sout, out: sout } : { in: sin, out: sout };
}
// cubic Hermite between p0 (slope m0/s) and p1 (slope m1/s) over dt seconds at u∈[0,1]
export function hermite(p0, m0, p1, m1, dt, u) {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 * dt + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1 * dt;
}
// Interpolated vector between keys a (index i) and b (index i+1) at u, per component, for an
// 'ease' segment: Hermite with each key's slopes. `es` = Euler chain for rotation tracks.
export function easeVector(keys, i, ch, u, es = null) {
  const a = keys[i], b = keys[i + 1];
  const va = values(keys, ch, i, es), vb = values(keys, ch, i + 1, es);
  const dt = b.t - a.t;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const m0 = keySlopes(keys, i, ch, c, es).out, m1 = keySlopes(keys, i + 1, ch, c, es).in;
    out[c] = hermite(va[c], m0, vb[c], m1, dt, u);
  }
  return out;
}
// Scalar curve sample for one channel component at time t (what the Graph Editor draws).
export function evaluateComponent(keys, t, ch, comp, es = null) {
  if (!keys.length) return null;
  const val = (i) => values(keys, ch, i, es)[comp];
  if (t <= keys[0].t) return val(0);
  if (t >= keys[keys.length - 1].t) return val(keys.length - 1);
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (a.i === 'step') return val(i);
  const u = (t - a.t) / (b.t - a.t);
  if (a.i === 'ease') return hermite(val(i), keySlopes(keys, i, ch, comp, es).out, val(i + 1), keySlopes(keys, i + 1, ch, comp, es).in, b.t - a.t, u);
  return val(i) + (val(i + 1) - val(i)) * u;
}

// Set a handle from a dragged handle position: slope = dv/dt on that side.
// 'aligned' keeps both sides equal; 'free' moves one side; auto/flat become aligned.
// The caller materialises auto/flat handles first (setKeyHandleMode(keys, i, ch, 'aligned')) so
// the untouched components keep their current shape.
export function setKeyTangent(key, side, comp, slope, { free = false } = {}) {
  const h = key.h && key.h.in && key.h.out ? key.h : { m: 'aligned', in: [0, 0, 0], out: [0, 0, 0] };
  h.in = h.in.slice(); h.out = h.out.slice();
  if (free) h.m = 'free';
  if (h.m === 'aligned') { h.in[comp] = slope; h.out[comp] = slope; }
  else h[side][comp] = slope;
  key.h = h;
  return h;
}
export function setKeyHandleMode(keys, i, ch, mode, es = null) {
  const k = keys[i];
  if (mode === 'flat') { k.h = { m: 'flat' }; return; }
  if (mode === 'auto') { k.h = { m: 'auto' }; return; }
  // aligned / free: freeze the current effective slopes so nothing jumps
  const cur = [0, 1, 2].map((c) => keySlopes(keys, i, ch, c, es));
  k.h = { m: mode, in: cur.map((s) => s.in), out: cur.map((s) => s.out) };
}

// ---------- channels ----------
// Every animated channel of the clip, grouped by node (in outliner order when `order` given).
export function channelsOf(clip, { order = null, nodeById = null } = {}) {
  const ids = order || Object.keys(clip.tracks);
  const groups = [];
  for (const nodeId of ids) {
    const tr = clip.tracks[nodeId];
    if (!tr) continue;
    const node = nodeById ? nodeById(nodeId) : null;
    const channels = [];
    for (const def of CHANNEL_DEFS) {
      if (!tr[def.ch]?.length) continue;
      for (let c = 0; c < 3; c++) channels.push({ id: channelId(nodeId, def.ch, c), nodeId, ch: def.ch, comp: c, axis: def.comps[c], unit: def.unit, labelKey: def.labelKey });
    }
    if (channels.length) groups.push({ nodeId, node, channels });
  }
  return groups;
}

// ---------- simplification ----------
// Tolerance-based key removal for one track channel (all three components judged together):
// a key goes when the curve without it stays within `tol` of the original at every original
// key time and segment midpoint. Never removed: first/last keys, keys whose interpolation
// differs from the previous key (stepped boundaries, pauses), and — for rotations — anything
// that would change the number or direction of turns (guaranteed by working on unwrapped
// angles: between two kept keys the turn count is fixed by their angle difference, and any
// intermediate extremum or reversal larger than `tol` fails the deviation check).
export function simplifyKeys(keys, ch, tol, es = null) {
  if (keys.length <= 2) return { keys: keys.slice(), removed: 0 };
  const chain = ch === 'rot' ? (es || trackEuler(keys)) : null;
  const val = (k, i) => (ch === 'rot' ? chain[i] : k.v);
  const orig = keys.map((k, i) => ({ t: k.t, v: val(k, i).slice(), i: k.i, h: k.h, e: ch === 'rot' ? chain[i].slice() : undefined, key: k }));
  const probes = [];
  for (let i = 0; i < orig.length; i++) { probes.push(orig[i].t); if (i < orig.length - 1) probes.push((orig[i].t + orig[i + 1].t) / 2); }
  const evalAt = (arr, t) => {
    const ks = arr.map((o) => ({ t: o.t, v: o.v, i: o.i, h: o.h, e: o.e }));
    return [0, 1, 2].map((c) => evaluateComponent(ks, t, ch, c, ch === 'rot' ? ks.map((k) => k.e) : null));
  };
  const reference = probes.map((t) => evalAt(orig, t));
  let kept = orig.slice();
  let removed = 0;
  for (;;) {
    let best = -1, bestErr = Infinity;
    for (let i = 1; i < kept.length - 1; i++) {
      if (kept[i].i !== kept[i - 1].i || kept[i].i === 'step' || kept[i - 1].i === 'step') continue;
      const trial = kept.slice(0, i).concat(kept.slice(i + 1));
      let err = 0;
      for (let p = 0; p < probes.length && err <= tol; p++) {
        const v = evalAt(trial, probes[p]);
        for (let c = 0; c < 3; c++) err = Math.max(err, Math.abs(v[c] - reference[p][c]));
      }
      if (err <= tol && err < bestErr) { bestErr = err; best = i; }
    }
    if (best < 0) break;
    kept = kept.slice(0, best).concat(kept.slice(best + 1));
    removed++;
  }
  return { keys: kept.map((o) => o.key), removed };
}

// Keys within `tol` seconds of a time (for keyframe snapping in the Graph Editor).
export function nearestKeyTime(times, t, tol) {
  let best = null;
  for (const kt of times) if (Math.abs(kt - t) <= tol && (best === null || Math.abs(kt - t) < Math.abs(best - t))) best = kt;
  return best;
}
