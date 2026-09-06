// Animation clips, keyframes and interpolation.
//   clip = { id, name, duration, loop, playhead, tracks: { [nodeId]: { pos: Key[], rot: Key[] } } }
//   Key  = { t, v: number[] (vec3 or quat), i: 'linear' | 'step' | 'ease', e?: [x,y,z] }
//   Rotation keys may carry `e`, the authored Euler angles in degrees, UNWRAPPED
//   (450, 720, -1080 …). Between two keys that both carry `e` the angles are
//   interpolated component-wise, so the number and direction of turns the user
//   authored is exactly what plays; keys without `e` (IK, retargeting, baked
//   data) interpolate by shortest-arc slerp as before.
import { v3, quat } from '../core/math.js';

export const MIN_KEY_SPACING = 0.03;
export const INTERPOLATIONS = ['linear', 'ease', 'step'];

export function createClip(project, name, duration = 2) {
  project.counter = (project.counter || 0) + 1;
  const clip = { id: `c${project.counter}`, name, duration, loop: true, playhead: 0, tracks: {} };
  project.clips.push(clip);
  return clip;
}

export function uniqueClipName(project, base) {
  const names = new Set(project.clips.map((c) => c.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base}.${String(n).padStart(3, '0')}`)) n++;
  return `${base}.${String(n).padStart(3, '0')}`;
}

export function duplicateClip(project, clip) {
  const copy = JSON.parse(JSON.stringify(clip));
  project.counter = (project.counter || 0) + 1;
  copy.id = `c${project.counter}`;
  copy.name = uniqueClipName(project, clip.name);
  project.clips.push(copy);
  return copy;
}

export const getClip = (project, id) => project.clips.find((c) => c.id === id) || null;
export const activeClip = (project) => getClip(project, project.activeClipId);

export function track(clip, nodeId, create = false) {
  let t = clip.tracks[nodeId];
  if (!t && create) t = clip.tracks[nodeId] = { pos: [], rot: [] };
  return t || null;
}

export const snapTime = (t) => Math.round(t * 1000) / 1000;

// Insert or replace a key (keys closer than MIN_KEY_SPACING are merged).
export function insertKey(clip, nodeId, channel, t, v, interp = 'linear', e = null) {
  const tr = track(clip, nodeId, true);
  const keys = tr[channel];
  t = snapTime(t);
  const existing = keys.find((k) => Math.abs(k.t - t) < MIN_KEY_SPACING - 1e-9);
  if (existing) { existing.v = v.slice(); if (interp) existing.i = interp; if (channel === 'rot') { if (e) existing.e = e.slice(); else delete existing.e; } return existing; }
  const k = { t, v: v.slice(), i: interp };
  if (channel === 'rot' && e) k.e = e.slice();
  keys.push(k);
  keys.sort((a, b) => a.t - b.t);
  return k;
}

export function removeKey(clip, nodeId, channel, t) {
  const tr = track(clip, nodeId);
  if (!tr) return;
  tr[channel] = tr[channel].filter((k) => Math.abs(k.t - t) > 1e-9);
  if (!tr.pos.length && !tr.rot.length) delete clip.tracks[nodeId];
}

export function pruneEmptyTracks(clip) {
  for (const id of Object.keys(clip.tracks)) {
    const tr = clip.tracks[id];
    if (!tr.pos.length && !tr.rot.length) delete clip.tracks[id];
  }
}

function easeInOut(u) { return u * u * (3 - 2 * u); }

export function evaluateKeys(keys, t, channel) {
  if (channel === 'rot') { const r = evaluateRotation(keys, t); return r ? r.q : null; }
  if (!keys || !keys.length) return null;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (a.i === 'step') return a.v;
  let u = (t - a.t) / (b.t - a.t);
  if (a.i === 'ease') u = easeInOut(u);
  return v3.lerp(a.v, b.v, u);
}
// Rotation at time t → { q, e } (e = unwrapped Euler when the surrounding keys carry it, else null).
export function evaluateRotation(keys, t) {
  if (!keys || !keys.length) return null;
  const at = (k) => ({ q: k.v, e: k.e || null });
  if (t <= keys[0].t) return at(keys[0]);
  const last = keys[keys.length - 1];
  if (t >= last.t) return at(last);
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (a.i === 'step') return at(a);
  let u = (t - a.t) / (b.t - a.t);
  if (a.i === 'ease') u = easeInOut(u);
  if (a.e && b.e) {
    // authored turns: interpolate the unwrapped angles, never the shortest arc
    const e = [a.e[0] + (b.e[0] - a.e[0]) * u, a.e[1] + (b.e[1] - a.e[1]) * u, a.e[2] + (b.e[2] - a.e[2]) * u];
    return { q: quat.fromEulerDeg(e), e };
  }
  return { q: quat.slerp(a.v, b.v, u), e: null };
}

// Evaluate all tracks of a clip → Map nodeId → {pos?, rot?, rotE?}
export function evaluateClip(clip, t) {
  const poses = new Map();
  for (const [nodeId, tr] of Object.entries(clip.tracks)) {
    const p = evaluateKeys(tr.pos, t, 'pos');
    const r = evaluateRotation(tr.rot, t);
    if (p || r) poses.set(nodeId, { pos: p || undefined, rot: r ? r.q : undefined, rotE: r?.e || undefined });
  }
  return poses;
}

// All key times in a clip (for snapping / baking breakpoints)
export function keyTimes(clip, nodeIds = null) {
  const s = new Set();
  for (const [id, tr] of Object.entries(clip.tracks)) {
    if (nodeIds && !nodeIds.has(id)) continue;
    for (const k of tr.pos) s.add(k.t);
    for (const k of tr.rot) s.add(k.t);
  }
  return [...s].sort((a, b) => a - b);
}

// Keys as flat selectable records: { nodeId, channel, t }
export function allKeys(clip) {
  const out = [];
  for (const [nodeId, tr] of Object.entries(clip.tracks)) {
    for (const k of tr.pos) out.push({ nodeId, channel: 'pos', t: k.t, key: k });
    for (const k of tr.rot) out.push({ nodeId, channel: 'rot', t: k.t, key: k });
  }
  return out;
}

export const keyRef = (nodeId, channel, t) => `${nodeId}|${channel}|${snapTime(t)}`;

// Move a set of keys by dt (clamped ≥ 0); merges into existing keys at the target time.
export function moveKeys(clip, refs, dt) {
  const moving = [];
  for (const [nodeId, tr] of Object.entries(clip.tracks)) {
    for (const ch of ['pos', 'rot']) {
      for (const k of tr[ch]) if (refs.has(keyRef(nodeId, ch, k.t))) moving.push({ nodeId, ch, k });
    }
  }
  if (!moving.length) return new Set();
  const minT = Math.min(...moving.map((m) => m.k.t));
  if (minT + dt < 0) dt = -minT;
  const newRefs = new Set();
  // detach, then reinsert
  for (const m of moving) {
    const tr = clip.tracks[m.nodeId];
    tr[m.ch] = tr[m.ch].filter((k) => k !== m.k);
  }
  for (const m of moving) {
    const nt = snapTime(m.k.t + dt);
    insertKey(clip, m.nodeId, m.ch, nt, m.k.v, m.k.i, m.k.e);
    newRefs.add(keyRef(m.nodeId, m.ch, nt));
  }
  return newRefs;
}

export function deleteKeys(clip, refs) {
  for (const [nodeId, tr] of Object.entries(clip.tracks)) {
    for (const ch of ['pos', 'rot']) tr[ch] = tr[ch].filter((k) => !refs.has(keyRef(nodeId, ch, k.t)));
  }
  pruneEmptyTracks(clip);
}

export function copyKeys(clip, refs) {
  const out = [];
  for (const [nodeId, tr] of Object.entries(clip.tracks)) {
    for (const ch of ['pos', 'rot']) for (const k of tr[ch]) if (refs.has(keyRef(nodeId, ch, k.t))) out.push({ nodeId, ch, t: k.t, v: k.v.slice(), i: k.i, e: k.e ? k.e.slice() : undefined });
  }
  if (!out.length) return null;
  const t0 = Math.min(...out.map((k) => k.t));
  return out.map((k) => ({ ...k, t: k.t - t0 }));
}

export function pasteKeys(clip, clipboard, atTime, nodeRemap = null) {
  const refs = new Set();
  for (const k of clipboard) {
    const nodeId = nodeRemap?.get(k.nodeId) || k.nodeId;
    const nt = snapTime(atTime + k.t);
    insertKey(clip, nodeId, k.ch, nt, k.v, k.i, k.e);
    refs.add(keyRef(nodeId, k.ch, nt));
  }
  return refs;
}

export function setInterpolation(clip, refs, interp) {
  for (const [nodeId, tr] of Object.entries(clip.tracks)) {
    for (const ch of ['pos', 'rot']) for (const k of tr[ch]) if (refs.has(keyRef(nodeId, ch, k.t))) k.i = interp;
  }
}

export function clipEnd(clip) {
  let end = clip.duration;
  for (const t of keyTimes(clip)) end = Math.max(end, t);
  return end;
}

// Validation helper: pairs of keys closer than the minimum spacing
export function tooCloseKeys(clip) {
  const out = [];
  for (const [nodeId, tr] of Object.entries(clip.tracks)) {
    for (const ch of ['pos', 'rot']) {
      const ks = tr[ch];
      for (let i = 1; i < ks.length; i++) if (ks[i].t - ks[i - 1].t < MIN_KEY_SPACING - 1e-9) out.push({ nodeId, ch, t: ks[i].t });
    }
  }
  return out;
}
