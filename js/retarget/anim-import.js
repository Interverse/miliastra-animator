// Animation file import → a loader-independent "source skeleton + clips" model.
//
// Formats: .fbx (binary/ASCII), .bvh, .gltf (self-contained) / .glb / .vrm,
// .dae (browser only), Unity .anim (generic transform curves only). Loaders are
// the Three.js addons; parsing is asynchronous and yields between stages so the
// UI keeps painting. Meshes are ignored (counted only) — this is animation-only.
//
// Normalised output:
//   { name, format, bones: [{ index, name, parent, restLocal:{pos,rot}, restWorld:{pos,rot}, depth }],
//     clips: [{ name, duration, sampleRate, tracks: Map(boneIndex → { pos:[{t,v}], rot:[{t,q}] }) }],
//     height, unitScale, meshes, warnings: [], humanoidMap: { role → boneName } | null }
import * as THREE from 'three';
import { parseUnityAnim } from './unity-anim.js';

export const FORMATS = {
  fbx: { ext: ['fbx'], label: 'FBX', binary: true },
  bvh: { ext: ['bvh'], label: 'BVH', binary: false },
  gltf: { ext: ['gltf'], label: 'glTF', binary: false },
  glb: { ext: ['glb', 'vrm', 'vrma'], label: 'GLB / VRM', binary: true },
  dae: { ext: ['dae'], label: 'Collada', binary: false, browserOnly: true },
  anim: { ext: ['anim'], label: 'Unity .anim (generic curves)', binary: false },
};
export const ACCEPT = Object.values(FORMATS).flatMap((f) => f.ext).map((e) => '.' + e).join(',');
export function formatOf(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  for (const [key, f] of Object.entries(FORMATS)) if (f.ext.includes(ext)) return key;
  return null;
}
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

// ---------- entry ----------
export async function loadAnimationFile(file, { onProgress = null } = {}) {
  const format = formatOf(file.name);
  if (!format) throw new Error('unsupported:' + (file.name.split('.').pop() || ''));
  onProgress?.('read');
  const bin = FORMATS[format].binary;
  const data = bin ? await file.arrayBuffer() : await file.text();
  await yieldUI();
  onProgress?.('parse');
  return loadAnimationData(data, file.name, format, { onProgress });
}

export async function loadAnimationData(data, fileName, format = formatOf(fileName), { onProgress = null } = {}) {
  const warnings = [];
  let root, animations = [], humanoidMap = null;
  if (format === 'fbx') {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
    root = new FBXLoader().parse(data, '');
    animations = root.animations || [];
  } else if (format === 'bvh') {
    const { BVHLoader } = await import('three/addons/loaders/BVHLoader.js');
    const res = new BVHLoader().parse(data);
    root = new THREE.Group();
    root.add(res.skeleton.bones[0]);
    animations = [res.clip];
  } else if (format === 'gltf' || format === 'glb') {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(data, '', resolve, reject));
    root = gltf.scene;
    animations = gltf.animations || [];
    humanoidMap = vrmHumanoid(gltf);
    if (typeof data === 'string' && /"uri"\s*:\s*"(?!data:)/.test(data)) warnings.push('externalBuffers');
  } else if (format === 'dae') {
    if (typeof DOMParser === 'undefined') throw new Error('browserOnly:dae');
    const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
    const res = new ColladaLoader().parse(data, '');
    root = res.scene;
    animations = res.animations || res.scene.animations || [];
  } else if (format === 'anim') {
    const parsed = parseUnityAnim(data);
    if (parsed.muscle) throw new Error('unityMuscle');
    root = parsed.root; animations = parsed.animations; warnings.push(...parsed.warnings);
  } else throw new Error('unsupported:' + format);
  await yieldUI();
  onProgress?.('skeleton');
  const src = buildSource(root, animations, fileName, format, warnings);
  src.humanoidMap = humanoidMap;
  onProgress?.('done');
  return src;
}

// ---------- normalisation ----------
function buildSource(root, animations, name, format, warnings) {
  root.updateMatrixWorld(true);
  // animated node names
  const animated = new Set();
  for (const clip of animations) for (const tr of clip.tracks) { const n = trackNode(tr.name); if (n) animated.add(n); }
  // candidate bones: Bone objects, animated nodes and their ancestors (meshes/cameras/lights excluded)
  const all = [];
  root.traverse((o) => { if (o !== root && !o.isMesh && !o.isSkinnedMesh && !o.isCamera && !o.isLight && !o.isLine && !o.isPoints) all.push(o); });
  const keep = new Set();
  for (const o of all) if (o.isBone || animated.has(o.name)) { let c = o; while (c && c !== root) { keep.add(c); c = c.parent; } }
  let nodes = all.filter((o) => keep.has(o));
  if (!nodes.length) nodes = all; // static hierarchy: everything
  let meshes = 0; root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) meshes++; });
  const index = new Map(nodes.map((o, i) => [o, i]));
  const bones = nodes.map((o, i) => {
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    o.matrixWorld.decompose(wp, wq, ws);
    let parent = o.parent; while (parent && parent !== root && !index.has(parent)) parent = parent.parent;
    return { index: i, name: o.name || `node${i}`, parent: parent && index.has(parent) ? index.get(parent) : -1, restLocal: { pos: o.position.toArray(), rot: o.quaternion.toArray() }, restWorld: { pos: wp.toArray(), rot: wq.toArray() }, worldScale: ws.x, depth: 0 };
  });
  for (const b of bones) { let d = 0, p = b.parent; while (p >= 0) { d++; p = bones[p].parent; } b.depth = d; }
  // height from rest world positions (Y extent), unit guess: > 20 → centimetres
  const ys = bones.map((b) => b.restWorld.pos[1]);
  const height = Math.max(...ys) - Math.min(...ys) || 1;
  const unitScale = height > 20 ? 0.01 : height < 0.2 ? 10 : 1;
  const byName = new Map(bones.map((b) => [b.name, b.index]));
  const clips = animations.map((clip) => {
    const tracks = new Map();
    let maxT = 0, samples = 0, bad = 0;
    for (const tr of clip.tracks) {
      const nodeName = trackNode(tr.name);
      const prop = trackProp(tr.name);
      const bi = byName.get(nodeName);
      if (bi == null || (prop !== 'position' && prop !== 'quaternion')) continue;
      const t = tracks.get(bi) || { pos: [], rot: [] };
      const size = tr.getValueSize();
      for (let k = 0; k < tr.times.length; k++) {
        const time = tr.times[k];
        const v = Array.from(tr.values.subarray(k * size, k * size + size));
        if (v.some((x) => !Number.isFinite(x))) { bad++; continue; }
        if (prop === 'position') t.pos.push({ t: time, v }); else t.rot.push({ t: time, q: v });
        maxT = Math.max(maxT, time); samples++;
      }
      tracks.set(bi, t);
    }
    for (const t of tracks.values()) { t.pos.sort((a, b) => a.t - b.t); t.rot.sort((a, b) => a.t - b.t); }
    if (bad) warnings.push('nanSamples:' + bad);
    const keyCount = Math.max(0, ...[...tracks.values()].map((t) => Math.max(t.pos.length, t.rot.length)));
    const duration = clip.duration || maxT;
    const sampleRate = keyCount > 1 && duration > 0 ? (keyCount - 1) / duration : 0;
    if (sampleRate > 240) warnings.push('highSampleRate:' + Math.round(sampleRate));
    return { name: clip.name || 'Animation', duration, sampleRate, tracks, keyCount, samples };
  });
  return { name, format, bones, clips, height: height * unitScale, rawHeight: height, unitScale, meshes, warnings };
}
function trackNode(trackName) {
  const p = THREE.PropertyBinding.parseTrackName(trackName);
  if (p.objectName === 'bones' && p.objectIndex != null) return p.objectIndex;
  return p.nodeName || null;
}
function trackProp(trackName) { return THREE.PropertyBinding.parseTrackName(trackName).propertyName; }

// VRM humanoid bone mapping (0.x and 1.0) → { role → node name }
function vrmHumanoid(gltf) {
  const json = gltf.parser?.json;
  if (!json) return null;
  const nodes = json.nodes || [];
  const map = {};
  const v1 = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  const v0 = json.extensions?.VRM?.humanoid?.humanBones;
  const put = (bone, nodeIdx) => { const role = VRM_ROLES[bone]; const n = nodes[nodeIdx]; if (role && n) map[role] = n.name || `node${nodeIdx}`; };
  if (v1) for (const [bone, val] of Object.entries(v1)) put(bone, val.node);
  else if (Array.isArray(v0)) for (const hb of v0) put(hb.bone, hb.node);
  return Object.keys(map).length ? map : null;
}
const VRM_ROLES = {
  hips: 'hips', spine: 'spine', chest: 'chest', upperChest: 'chest', neck: 'neck', head: 'head',
  leftShoulder: 'shoulder.L', leftUpperArm: 'upperArm.L', leftLowerArm: 'forearm.L', leftHand: 'hand.L',
  rightShoulder: 'shoulder.R', rightUpperArm: 'upperArm.R', rightLowerArm: 'forearm.R', rightHand: 'hand.R',
  leftUpperLeg: 'thigh.L', leftLowerLeg: 'shin.L', leftFoot: 'foot.L', leftToes: 'toe.L',
  rightUpperLeg: 'thigh.R', rightLowerLeg: 'shin.R', rightFoot: 'foot.R', rightToes: 'toe.R',
};

// ---------- sampling ----------
function lerpPos(keys, t) {
  if (!keys.length) return null;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid].t <= t) lo = mid; else hi = mid; }
  const a = keys[lo], b = keys[hi], u = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return a.v.map((x, i) => x + (b.v[i] - x) * u);
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function slerpRot(keys, t) {
  if (!keys.length) return null;
  if (t <= keys[0].t) return keys[0].q;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].q;
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid].t <= t) lo = mid; else hi = mid; }
  const a = keys[lo], b = keys[hi], u = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return _qa.fromArray(a.q).slerp(_qb.fromArray(b.q), u).toArray();
}
// World transforms of every source bone at time t (rest for unanimated channels).
export function sourcePoseAt(src, clip, t) {
  const world = new Array(src.bones.length);
  const P = new THREE.Vector3(), Q = new THREE.Quaternion(), pp = new THREE.Vector3(), pq = new THREE.Quaternion();
  for (const b of src.bones) {
    const tr = clip.tracks.get(b.index);
    const lp = (tr && lerpPos(tr.pos, t)) || b.restLocal.pos;
    const lq = (tr && slerpRot(tr.rot, t)) || b.restLocal.rot;
    if (b.parent >= 0) {
      const pw = world[b.parent];
      pp.fromArray(pw.pos); pq.fromArray(pw.rot);
      P.fromArray(lp).multiplyScalar(pw.scale ?? 1).applyQuaternion(pq).add(pp);
      Q.copy(pq).multiply(new THREE.Quaternion().fromArray(lq));
      world[b.index] = { pos: P.toArray(), rot: Q.normalize().toArray(), scale: pw.scale ?? 1 };
    } else {
      // root keeps the loader's world scale (e.g. FBX unit conversion) for its subtree
      const s = b.worldScale || 1;
      P.fromArray(lp).multiplyScalar(s); Q.fromArray(lq);
      world[b.index] = { pos: P.toArray(), rot: Q.toArray(), scale: s };
    }
  }
  return world;
}
// All distinct key times of the mapped bones (sorted), or a regular grid when too dense.
export function clipKeyTimes(clip, boneIndices, maxKeys = 4000) {
  const set = new Set([0]);
  for (const bi of boneIndices) { const tr = clip.tracks.get(bi); if (!tr) continue; for (const k of tr.pos) set.add(k.t); for (const k of tr.rot) set.add(k.t); }
  set.add(clip.duration);
  let times = [...set].filter((t) => t >= 0 && t <= clip.duration + 1e-9).sort((a, b) => a - b);
  if (times.length > maxKeys) { const n = maxKeys; times = Array.from({ length: n }, (_, i) => clip.duration * i / (n - 1)); }
  return times;
}
