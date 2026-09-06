// Unity .anim (YAML) — generic transform curves only.
//
// A Unity AnimationClip stores either transform curves (m_RotationCurves /
// m_EulerCurves / m_PositionCurves with a `path` per bone) or, for Humanoid
// clips, muscle-space float curves ("Spine Front-Back", "LeftFoot T.x" …) that
// can only be turned into bone rotations by Unity's avatar muscle mapping.
// Generic clips are converted to Three.js objects + an AnimationClip; humanoid
// muscle clips are reported as unsupported (`muscle: true`).
import * as THREE from 'three';

export function parseUnityAnim(text) {
  const warnings = [];
  const section = (key) => {
    const i = text.indexOf('\n  ' + key + ':');
    if (i < 0) return '';
    const rest = text.slice(i + 1);
    const m = rest.match(/\n  m_[A-Za-z]+:/);
    return m ? rest.slice(0, m.index) : rest;
  };
  const rot = parseCurves(section('m_RotationCurves'), 4);
  const eul = parseCurves(section('m_EulerCurves'), 3);
  const pos = parseCurves(section('m_PositionCurves'), 3);
  const floats = section('m_FloatCurves');
  const muscle = !rot.length && !eul.length && !pos.length && /attribute:\s*(RootT|RootQ|Spine|LeftFoot|RightFoot|Chest|Neck|Head)/.test(floats);
  if (muscle) return { muscle: true, warnings, root: null, animations: [] };
  const name = (text.match(/\n  m_Name:\s*(.+)/) || [])[1]?.trim() || 'Unity clip';
  // hierarchy from paths ("Hips/Spine/Chest")
  const paths = new Set([...rot, ...eul, ...pos].map((c) => c.path).filter((p) => p != null));
  const root = new THREE.Group();
  const nodes = new Map();
  const nodeFor = (path) => {
    if (nodes.has(path)) return nodes.get(path);
    const parts = path.split('/');
    const bone = new THREE.Bone();
    bone.name = parts[parts.length - 1] || 'root';
    const parentPath = parts.slice(0, -1).join('/');
    (parentPath ? nodeFor(parentPath) : root).add(bone);
    nodes.set(path, bone);
    return bone;
  };
  for (const p of paths) nodeFor(p);
  const tracks = [];
  let duration = 0;
  for (const c of rot) { const times = c.keys.map((k) => k.time), values = c.keys.flatMap((k) => [k.value.x, k.value.y, k.value.z, k.value.w]); tracks.push(new THREE.QuaternionKeyframeTrack(nodeFor(c.path).name + '.quaternion', times, values)); duration = Math.max(duration, ...times); }
  for (const c of eul) { const times = c.keys.map((k) => k.time), values = c.keys.flatMap((k) => { const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(k.value.x * Math.PI / 180, k.value.y * Math.PI / 180, k.value.z * Math.PI / 180, 'ZXY')); return q.toArray(); }); tracks.push(new THREE.QuaternionKeyframeTrack(nodeFor(c.path).name + '.quaternion', times, values)); duration = Math.max(duration, ...times); }
  for (const c of pos) { const times = c.keys.map((k) => k.time), values = c.keys.flatMap((k) => [k.value.x, k.value.y, k.value.z]); tracks.push(new THREE.VectorKeyframeTrack(nodeFor(c.path).name + '.position', times, values)); duration = Math.max(duration, ...times); }
  if (!tracks.length) warnings.push('noTransformCurves');
  return { muscle: false, warnings, root, animations: tracks.length ? [new THREE.AnimationClip(name, duration, tracks)] : [] };
}

// curve entries: "- curve: ... m_Curve: - {time, value: {x,y,z[,w]}} ... path: X"
function parseCurves(sec, dims) {
  const out = [];
  if (!sec) return out;
  const entries = sec.split(/\n  - /).slice(1);
  for (const e of entries) {
    const path = (e.match(/\n\s+path:\s*(.*)/) || [])[1] ?? '';
    const keys = [];
    const re = dims === 4
      ? /time:\s*([-\d.eE+]+)\s*\n\s*value:\s*\{x:\s*([-\d.eE+]+),\s*y:\s*([-\d.eE+]+),\s*z:\s*([-\d.eE+]+),\s*w:\s*([-\d.eE+]+)\}/g
      : /time:\s*([-\d.eE+]+)\s*\n\s*value:\s*\{x:\s*([-\d.eE+]+),\s*y:\s*([-\d.eE+]+),\s*z:\s*([-\d.eE+]+)\}/g;
    let m;
    while ((m = re.exec(e))) keys.push({ time: +m[1], value: { x: +m[2], y: +m[3], z: +m[4], w: dims === 4 ? +m[5] : undefined } });
    if (keys.length) out.push({ path: path.trim(), keys });
  }
  return out;
}
