// Retargeting: source skeleton animation → keys on the project's bones.
//
// Rest-pose aware: for every mapped bone the animated WORLD rotation delta
// relative to the source rest pose is measured, rotated into a canonical frame
// by the correction Cs (minimal rotation taking the source bone's rest
// direction onto the target bone's rest direction — this is what makes an
// A-pose source drive a T-pose target), and applied to the target bone's rest
// world rotation. Local rotations are then derived through the target
// hierarchy, so proportions differ freely: only rotations travel, plus the
// hips translation (root motion) which is scaled to the character height and
// can be kept, made in-place or dropped. Keys are reduced afterwards within a
// tolerance and never closer than the Miliastra minimum of 0.03 s.
import { getNode, worldTransforms, orderedNodes, boneTail, localTransform, editableLocal } from '../scene/scene.js';
import { createClip, insertKey, uniqueClipName } from '../anim/clips.js';
import { v3, quat, xf } from '../core/math.js';
import { sourcePoseAt, clipKeyTimes } from './anim-import.js';
import { ROLE_CHILD, MAJOR_ROLES, mappingIssues } from './bone-map.js';

export const TOLERANCES = { low: { pos: 0.01, rot: 1.5 }, normal: { pos: 0.003, rot: 0.5 }, high: { pos: 0.001, rot: 0.2 }, none: null };
export const ROOT_MODES = ['inPlace', 'keep', 'none'];
export const DEFAULT_OPTIONS = { rootMotion: 'inPlace', scaleToHeight: true, tolerance: 'normal', minSpacing: 0.03, ik: false };
const MIN_SPACING = 0.03;

// Height of the target rig (bones' heads and tails), objects as a fallback.
export function targetHeight(project) {
  const world = worldTransforms(project, null);
  let min = Infinity, max = -Infinity;
  for (const n of project.nodes) {
    if (n.type !== 'bone') continue;
    const w = world.get(n.id); if (!w) continue;
    const tail = boneTail(n, world);
    min = Math.min(min, w.pos[1], tail[1]); max = Math.max(max, w.pos[1], tail[1]);
  }
  if (!Number.isFinite(min)) for (const n of project.nodes) { const w = world.get(n.id); if (w) { min = Math.min(min, w.pos[1]); max = Math.max(max, w.pos[1]); } }
  return Number.isFinite(min) && max > min ? max - min : 1;
}

// Per-bone plan: correction and rest rotations.
export function planRetarget(project, src, mapping, roles) {
  const restT = worldTransforms(project, null);
  const roleToTarget = {}; for (const [tid, role] of Object.entries(roles)) roleToTarget[role] = tid;
  const plan = [];
  for (const [tid, si] of Object.entries(mapping)) {
    if (si == null) continue;
    const tb = getNode(project, tid), sb = src.bones[si], tw = restT.get(tid);
    if (!tb || !sb || !tw) continue;
    const role = roles[tid] || null;
    // target direction: the bone's own axis (Y along the bone by construction)
    const dt = quat.rotate(tw.rot, [0, 1, 0]);
    // source direction: towards the mapped child role if present, else the first child, else the bone's Y axis
    let ds = null;
    const childRole = role && ROLE_CHILD[role];
    const childTid = childRole && roleToTarget[childRole];
    const childSi = childTid != null ? mapping[childTid] : null;
    if (childSi != null && src.bones[childSi]) ds = v3.sub(src.bones[childSi].restWorld.pos, sb.restWorld.pos);
    if (!ds || v3.len(ds) < 1e-6) { const kid = src.bones.find((b) => b.parent === si); if (kid) ds = v3.sub(kid.restWorld.pos, sb.restWorld.pos); }
    if (!ds || v3.len(ds) < 1e-6) ds = quat.rotate(sb.restWorld.rot, [0, 1, 0]);
    const Cs = quat.fromUnitVectors(v3.norm(ds), v3.norm(dt));
    plan.push({ targetId: tid, srcIndex: si, role, Cs, Rt0: tw.rot, Rs0: sb.restWorld.rot, restLocal: { pos: tb.pos.slice(), rot: tb.rot.slice() } });
  }
  return plan;
}

// ---------- key reduction ----------
function interpPos(a, b, t) { const u = (t - a.t) / Math.max(1e-9, b.t - a.t); return v3.lerp(a.v, b.v, u); }
function interpRot(a, b, t) { const u = (t - a.t) / Math.max(1e-9, b.t - a.t); return quat.slerp(a.v, b.v, u); }
export function reduceKeys(keys, kind, tol, minSpacing = MIN_SPACING) {
  if (keys.length <= 2) return keys.slice();
  let kept;
  if (!tol) kept = keys.map((_, i) => i);
  else {
    const keep = new Set([0, keys.length - 1]);
    const limit = kind === 'rot' ? tol.rot * Math.PI / 180 : tol.pos;
    const stack = [[0, keys.length - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      if (hi - lo < 2) continue;
      let worst = -1, worstE = 0;
      for (let i = lo + 1; i < hi; i++) {
        const e = kind === 'rot' ? quat.angle(keys[i].v, interpRot(keys[lo], keys[hi], keys[i].t)) : v3.dist(keys[i].v, interpPos(keys[lo], keys[hi], keys[i].t));
        if (e > worstE) { worstE = e; worst = i; }
      }
      if (worstE > limit && worst > 0) { keep.add(worst); stack.push([lo, worst], [worst, hi]); }
    }
    kept = [...keep].sort((a, b) => a - b);
  }
  // minimum spacing (Miliastra 0.03 s): drop keys that follow too closely; the last key wins over its predecessor
  const out = [];
  for (const i of kept) {
    const k = keys[i];
    if (out.length && k.t - out[out.length - 1].t < minSpacing - 1e-9) {
      if (i === kept[kept.length - 1] && out.length > 1) out.pop(); else continue;
    }
    out.push(k);
  }
  return out;
}

// ---------- validation ----------
export function validateRetarget(project, src, clip, mapping, roles) {
  const warnings = [];
  const targetBones = project.nodes.filter((n) => n.type === 'bone');
  const targetRoles = {}; for (const [tid, r] of Object.entries(roles)) targetRoles[r] = tid;
  if (!targetBones.length) warnings.push({ kind: 'noTargetBones' });
  if (!src.bones.length) warnings.push({ kind: 'noSourceBones' });
  if (!clip || !clip.tracks.size) warnings.push({ kind: 'emptyClip' });
  const mapped = Object.values(mapping).filter((v) => v != null).length;
  if (!mapped) warnings.push({ kind: 'nothingMapped' });
  for (const i of mappingIssues(mapping, targetBones, src.bones, targetRoles)) warnings.push(i);
  if (!Object.values(roles).includes('hips')) warnings.push({ kind: 'noHipsMapped' });
  if (clip?.sampleRate > 240) warnings.push({ kind: 'highSampleRate', rate: Math.round(clip.sampleRate) });
  const h = src.height;
  if (h < 0.3 || h > 6) warnings.push({ kind: 'scaleAnomaly', height: h });
  for (const w of src.warnings || []) { if (/^nanSamples/.test(w)) warnings.push({ kind: 'nanSamples', n: +w.split(':')[1] }); if (w === 'externalBuffers') warnings.push({ kind: 'externalBuffers' }); }
  // source hierarchy sanity: hips should be an ancestor of mapped limb bones
  const hipsTid = targetRoles.hips; const hipsSi = hipsTid != null ? mapping[hipsTid] : null;
  if (hipsSi != null) {
    const isDesc = (i) => { let p = src.bones[i]?.parent; while (p >= 0) { if (p === hipsSi) return true; p = src.bones[p].parent; } return false; };
    const limb = ['thigh.L', 'thigh.R', 'upperArm.L', 'upperArm.R'].map((r) => targetRoles[r]).filter((t) => t && mapping[t] != null);
    if (limb.length && !limb.every((t) => isDesc(mapping[t]))) warnings.push({ kind: 'hierarchy' });
  }
  return warnings;
}

// ---------- retarget ----------
export async function retargetClip(project, src, clip, mapping, roles, options = {}, onProgress = null) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const tol = TOLERANCES[o.tolerance] ?? TOLERANCES.normal;
  const plan = planRetarget(project, src, mapping, roles);
  const planBy = new Map(plan.map((p) => [p.targetId, p]));
  const times = clipKeyTimes(clip, plan.map((p) => p.srcIndex));
  const restT = worldTransforms(project, null);
  const order = orderedNodes(project).map((r) => r.node).filter((n) => n.type === 'bone');
  const hips = plan.find((p) => p.role === 'hips');
  const hipsSrcRest = hips ? src.bones[hips.srcIndex].restWorld.pos : null;
  const scale = src.unitScale * (o.scaleToHeight && src.height > 0 ? targetHeight(project) / src.height : 1);
  const rotKeys = new Map(plan.map((p) => [p.targetId, []]));
  const posKeys = hips ? [] : null;
  const ikTargets = o.ik ? project.constraints.filter((k) => k.enabled && getNode(project, k.boneId)?.type === 'bone' && getNode(project, k.targetId)) : [];
  const ikKeys = new Map(ikTargets.map((k) => [k.targetId, []]));
  let bad = 0;
  for (let ti = 0; ti < times.length; ti++) {
    const t = times[ti];
    const sw = sourcePoseAt(src, clip, t);
    const tw = new Map();
    for (const tb of order) {
      const parentW = tb.parent ? (tw.get(tb.parent) || restT.get(tb.parent)) : { pos: project.settings?.globalOffset || [0, 0, 0], rot: [0, 0, 0, 1] };
      const p = planBy.get(tb.id);
      const restLocal = localTransform(tb); // effective (basis included)
      let local = restLocal;
      if (p) {
        const S = sw[p.srcIndex];
        const delta = quat.mul(S.rot, quat.conj(p.Rs0));
        const deltaC = quat.mul(quat.mul(p.Cs, delta), quat.conj(p.Cs));
        const worldRot = quat.norm(quat.mul(deltaC, p.Rt0));
        const localRot = quat.norm(quat.mul(quat.conj(parentW.rot), worldRot));
        let localPos = restLocal.pos;
        if (p.role === 'hips' && o.rootMotion !== 'none' && hipsSrcRest) {
          // the full travel is always keyed; "in place" is the clip's Root Motion flag (non-destructive)
          const d = v3.scale(v3.sub(S.pos, hipsSrcRest), scale);
          localPos = v3.add(restLocal.pos, quat.rotate(quat.conj(parentW.rot), d));
        }
        if (localRot.some((x) => !Number.isFinite(x)) || localPos.some((x) => !Number.isFinite(x))) { bad++; local = restLocal; }
        else {
          local = { pos: localPos, rot: localRot };
          const ed = editableLocal(tb, local); // keys store editable values (basis stripped)
          rotKeys.get(tb.id).push({ t, v: ed.rot });
          if (p.role === 'hips' && posKeys) posKeys.push({ t, v: ed.pos });
        }
      }
      tw.set(tb.id, xf.compose(parentW, local));
    }
    // IK: key the constraint targets at the FK tip tails
    for (const k of ikTargets) {
      const tip = getNode(project, k.boneId), w = tw.get(tip.id);
      if (!w) continue;
      const tail = v3.add(w.pos, quat.rotate(w.rot, [0, tip.length || 0.25, 0]));
      const tgt = getNode(project, k.targetId);
      const parentW = tgt.parent ? (tw.get(tgt.parent) || restT.get(tgt.parent)) : { pos: project.settings?.globalOffset || [0, 0, 0], rot: [0, 0, 0, 1] };
      ikKeys.get(k.targetId).push({ t, v: xf.localOf({ pos: tail, rot: [0, 0, 0, 1] }, parentW).pos });
    }
    if (ti % 200 === 199) { onProgress?.(ti / times.length); await new Promise((r) => setTimeout(r, 0)); }
  }
  // reduce + build clip
  const name = uniqueClipName(project, o.name || clip.name || 'Imported');
  const out = createClip(project, name, Math.max(MIN_SPACING, clip.duration));
  out.loop = !!o.loop;
  let before = 0, after = 0;
  const put = (id, ch, keys) => { before += keys.length; const r = reduceKeys(keys, ch, tol, o.minSpacing ?? MIN_SPACING); after += r.length; for (const k of r) insertKey(out, id, ch, snap(k.t), k.v, 'linear'); };
  for (const [tid, keys] of rotKeys) if (keys.length) put(tid, 'rot', keys);
  if (posKeys && posKeys.length && o.rootMotion !== 'none') { put(hips.targetId, 'pos', posKeys); out.rootNodeId = hips.targetId; out.rootMotion = o.rootMotion === 'keep'; }
  for (const [tid, keys] of ikKeys) if (keys.length) put(tid, 'pos', keys);
  const warnings = [];
  if (bad) warnings.push({ kind: 'nanSamples', n: bad });
  return { clip: out, warnings, stats: { samples: times.length, bones: plan.length, keysBefore: before, keysAfter: after, scale, rootMotion: o.rootMotion } };
}
const snap = (t) => Math.round(t * 1000) / 1000;

// Does the source clip move the hips horizontally (root motion present)?
export function detectRootMotion(src, clip, hipsIndex) {
  if (hipsIndex == null) return { present: false, distance: 0 };
  const tr = clip.tracks.get(hipsIndex);
  if (!tr || tr.pos.length < 2) return { present: false, distance: 0 };
  const a = tr.pos[0].v, b = tr.pos[tr.pos.length - 1].v;
  let maxD = 0;
  for (const k of tr.pos) maxD = Math.max(maxD, Math.hypot(k.v[0] - a[0], k.v[2] - a[2]));
  const d = maxD * src.unitScale;
  return { present: d > 0.05, distance: d, net: Math.hypot(b[0] - a[0], b[2] - a[2]) * src.unitScale };
}
