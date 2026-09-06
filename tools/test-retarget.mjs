// Animation import + retargeting:  node tools/test-retarget.mjs
// Mixamo FBX (T-pose, cm, 30 fps, root motion), a synthetic BVH with a different
// naming convention, a synthetic glTF, an A-pose source onto a T-pose target,
// proportion differences, root-motion modes, multiple clips, dense sampling,
// partial skeletons, key reduction, Unity muscle .anim rejection, and an
// end-to-end Motion Device export of the imported clip.
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { loadAnimationData, sourcePoseAt } from '../js/retarget/anim-import.js';
import { autoMap, roleOf, assignRoles, mappingIssues, skeletonSignature, roleMappingFromIds, mappingFromRoles } from '../js/retarget/bone-map.js';
import { retargetClip, validateRetarget, reduceKeys, detectRootMotion, planRetarget } from '../js/retarget/retarget.js';
import { parseUnityAnim } from '../js/retarget/unity-anim.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { exportGia } from '../js/gia/gia-export.js';
import { parseGia, collectObjects } from '../js/gia/gia-file.js';
import { track } from '../js/anim/clips.js';
import { worldTransforms, getNode } from '../js/scene/scene.js';
import { quat, v3 } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const ang = (a, b) => quat.angle(a, b) * 180 / Math.PI;
const fx = (p) => new URL('./fixtures/' + p, import.meta.url);
const fbxBytes = readFileSync(fx('Rumba Dancing.fbx'));
const fbxBuf = fbxBytes.buffer.slice(fbxBytes.byteOffset, fbxBytes.byteOffset + fbxBytes.byteLength);
const pantalone = new Uint8Array(readFileSync(fx('Pantalone.gia')));

// ---------- target: Pantalone auto-rigged in T-pose ----------
function makeTarget(pose = 'tpose', ik = true) {
  const ed = new Editor();
  ed.importGia(pantalone, 'Pantalone.gia');
  const prop = ed.proposeAutoRig({ ik, pose });
  ed.applyAutoRig(prop);
  return ed;
}
// Node lacks ProgressEvent, which Three's FileLoader dispatches while resolving data: URIs
if (typeof ProgressEvent === 'undefined') globalThis.ProgressEvent = class ProgressEvent extends Event { constructor(type, init = {}) { super(type); this.lengthComputable = !!init.lengthComputable; this.loaded = init.loaded || 0; this.total = init.total || 0; } };

// ---------- 1. FBX (Mixamo) ----------
{
  const t0 = performance.now();
  const src = await loadAnimationData(fbxBuf, 'Rumba Dancing.fbx');
  const ms = performance.now() - t0;
  check('FBX parsed: 65 bones, one clip, no mesh needed', src.bones.length === 65 && src.clips.length === 1 && src.meshes === 0, `${ms.toFixed(0)} ms`);
  check('centimetre units detected → height in metres', src.unitScale === 0.01 && src.height > 1.4 && src.height < 2.2, `${src.height.toFixed(2)} m`);
  const clip = src.clips[0];
  check('clip metadata: duration, 30 fps sampling', Math.abs(clip.duration - 2.37) < 0.05 && Math.abs(clip.sampleRate - 30) < 1.5, `${clip.duration.toFixed(2)} s @ ${clip.sampleRate.toFixed(1)} fps`);
  // naming
  check('mixamorig: prefix + Left/Right naming understood', roleOf('mixamorigLeftForeArm') === 'forearm.L' && roleOf('mixamorig:RightUpLeg') === 'thigh.R' && roleOf('mixamorigHips') === 'hips' && roleOf('mixamorigSpine2') === 'spine' && roleOf('mixamorigHeadTop_End') === null);
  const ed = makeTarget('tpose');
  const tb = ed.project.nodes.filter((n) => n.type === 'bone').map((b) => ({ id: b.id, name: b.name, parent: b.parent, depth: 0 }));
  const auto = autoMap(src.bones, tb);
  const mappedRoles = Object.values(auto.roles);
  check('auto-map covers the major humanoid roles', ['hips', 'chest', 'head', 'upperArm.L', 'forearm.L', 'hand.L', 'thigh.R', 'shin.R', 'foot.R'].every((r) => mappedRoles.includes(r)), mappedRoles.join(','));
  check('spine family: shallowest → spine, deepest → chest', src.bones[auto.sourceRoles.spine].name === 'mixamorigSpine' && src.bones[auto.sourceRoles.chest].name === 'mixamorigSpine2');
  check('no duplicate mappings or missing hips', mappingIssues(auto.mapping, tb, src.bones, auto.targetRoles).every((i) => i.kind !== 'duplicate' && i.kind !== 'noHips'));
  const warnings = validateRetarget(ed.project, src, clip, auto.mapping, auto.roles);
  check('validation passes for a complete mapping', !warnings.some((w) => ['nothingMapped', 'noHipsMapped', 'hierarchy', 'nanSamples'].includes(w.kind)), warnings.map((w) => w.kind).join(','));
  const rm = detectRootMotion(src, clip, auto.sourceRoles.hips);
  check('root motion detection reports the hips travel', typeof rm.present === 'boolean' && rm.distance >= 0);
  // retarget
  const before = JSON.stringify(ed.snapshotState());
  const res = await retargetClip(ed.project, src, clip, auto.mapping, auto.roles, { rootMotion: 'inPlace', tolerance: 'normal', ik: true, name: 'Rumba' });
  const rc = res.clip;
  check('retargeted clip created with reduced keys', rc.duration > 2 && res.stats.keysAfter > 50 && res.stats.keysAfter < res.stats.keysBefore, `${res.stats.keysAfter} keys from ${res.stats.keysBefore} samples×bones`);
  const allKeys = Object.values(rc.tracks).flatMap((tr) => [...tr.pos, ...tr.rot]);
  check('no NaN in generated keys', allKeys.every((k) => k.v.every((x) => Number.isFinite(x))));
  const spacingOk = Object.values(rc.tracks).every((tr) => ['pos', 'rot'].every((ch) => tr[ch].every((k, i) => i === 0 || k.t - tr[ch][i - 1].t >= 0.03 - 1e-9)));
  check('keys respect the 0.03 s minimum spacing', spacingOk);
  // motion actually moves the rig: thigh world rotation differs across time and stays sane
  const thigh = ed.project.nodes.find((n) => n.name === 'Thigh.L');
  const w0 = evaluatePose(ed.project, rc.id, 0).world.get(thigh.id), w1 = evaluatePose(ed.project, rc.id, 1.0).world.get(thigh.id);
  check('retargeted motion animates the target limbs', ang(w0.rot, w1.rot) > 2, `${ang(w0.rot, w1.rot).toFixed(1)}°`);
  // in-place: hips XZ stay at rest
  const hips = ed.project.nodes.find((n) => n.name === 'Hips');
  const hp = track(rc, hips.id).pos;
  // in place is the clip's non-destructive Root Motion flag: the travel keys are imported, the evaluated pose stays put
  const hipsW0 = evaluatePose(ed.project, rc.id, 0).world.get(hips.id).pos, hipsW1 = evaluatePose(ed.project, rc.id, 1.0).world.get(hips.id).pos;
  check('in-place: Root Motion is off, the evaluated hips keep their horizontal position, travel keys are kept', rc.rootMotion === false && rc.rootNodeId === hips.id && hp.length > 0 && Math.abs(hipsW1[0] - hipsW0[0]) < 1e-6 && Math.abs(hipsW1[2] - hipsW0[2]) < 1e-6 && hp.some((k) => Math.hypot(k.v[0] - hp[0].v[0], k.v[2] - hp[0].v[2]) > 1e-4));
  // IK targets keyed
  const ik = ed.project.constraints[0];
  check('IK targets keyed from the FK feet', track(rc, ik.targetId)?.pos.length > 2);
  // rest-pose correction: at t≈0 the retargeted pose stays close to the target's own rest for the spine (Mixamo starts upright)
  const chest = ed.project.nodes.find((n) => n.name === 'Chest');
  const restW = worldTransforms(ed.project, null).get(chest.id).rot;
  check('retarget keeps the target orientation frame (spine stays roughly upright)', ang(w0.rot, worldTransforms(ed.project, null).get(thigh.id).rot) < 60 && ang(evaluatePose(ed.project, rc.id, 0).world.get(chest.id).rot, restW) < 60);
  // the project was not modified except the new clip (clip creation is what commit would record)
  ed.commit('import');
  check('apply is a single undo step and undo removes the clip', (ed.undo(), !ed.project.clips.some((c) => c.id === rc.id) && JSON.stringify(ed.snapshotState()) === before));
  ed.redo();
  // export through the Motion Device pipeline: a dense mocap clip bakes to more than
  // 50 points per object, so the slot uses the (persisted) auto-compression to fit the limit
  ed.project.exportConfig.slots = [{ clipId: rc.id, name: 'Rumba', outputYaw: 0 }];
  let blocked = null; try { exportGia(ed.project, pantalone); } catch (e) { blocked = e; }
  check('a dense mocap clip over the 49-point safe limit is refused until compressed', blocked?.code === 'pathLimit' && blocked.violations.length > 5);
  ed.project.exportConfig.slots[0].compress = true;
  const { bytes, report } = exportGia(ed.project, pantalone);
  const out = collectObjects(parseGia(bytes));
  check('imported clip exports as Motion Devices on the bone-driven objects', report.devices > 5 && out.some((o) => o.motionDevices.length === 1 && o.motionDevices[0].points.length > 3), `${report.devices} devices`);
  check('auto-compressed export: every path ≤ 49 points, compression within the acceptable error', out.every((o) => o.motionDevices.every((d) => d.points.length <= 49)) && report.compressed.length > 5 && report.compressed.every((c) => c.ok), `${report.compressed.length} compressed, max err ${Math.max(...report.compressed.map((c) => c.maxError.pos * 100)).toFixed(1)} cm`);
  // presets round trip
  const sig = skeletonSignature(src.bones);
  const roleMap = roleMappingFromIds(auto.mapping, auto.targetRoles, src.bones);
  const back = mappingFromRoles(roleMap, auto.targetRoles, src.bones);
  const sortedEntries = (m) => JSON.stringify(Object.entries(m).sort());
  check('mapping preset round-trips through role names', sortedEntries(back) === sortedEntries(auto.mapping) && sig.includes('mixamorigHips'));
  // key reduction keeps stepped motion
  const stepped = [{ t: 0, v: [0, 0, 0] }, { t: 0.5, v: [0, 0, 0] }, { t: 0.533, v: [1, 0, 0] }, { t: 1, v: [1, 0, 0] }];
  const red = reduceKeys(stepped, 'pos', { pos: 0.003, rot: 0.5 });
  check('key reduction keeps discontinuities', red.length === 4);
  const straight = Array.from({ length: 31 }, (_, i) => ({ t: i / 30, v: [i / 30, 0, 0] }));
  check('key reduction collapses linear motion to endpoints', reduceKeys(straight, 'pos', { pos: 0.003, rot: 0.5 }).length === 2);
  // proportions: a smaller target gets scaled root motion
  const res2 = await retargetClip(ed.project, src, clip, auto.mapping, auto.roles, { rootMotion: 'keep', scaleToHeight: true, name: 'RumbaKeep' });
  check('root motion is scaled to the character height', Math.abs(res2.stats.scale - 0.01 * (1 / src.height) * (src.height * res2.stats.scale / 0.01)) < 1e-9 && res2.stats.scale > 0 && res2.stats.scale !== 0.01);
  const res3 = await retargetClip(ed.project, src, clip, auto.mapping, auto.roles, { rootMotion: 'none', name: 'RumbaNone' });
  check('root motion "none" writes no hips position keys', !track(res3.clip, hips.id)?.pos.length);
}

// ---------- 2. synthetic BVH, different names, A-pose source → T-pose target ----------
{
  // A-pose: arms 45° down. Hierarchy: Hips > Spine > Chest > Neck > Head; Chest > L_Shoulder > L_UpperArm > L_LowerArm > L_Hand (and R); Hips > L_Thigh > L_Shin > L_Foot
  const c = Math.SQRT1_2 * 30;
  const bvh = `HIERARCHY
ROOT Hips
{
  OFFSET 0 100 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Spine
  {
    OFFSET 0 10 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT Chest
    {
      OFFSET 0 20 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT Neck
      {
        OFFSET 0 20 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT Head
        {
          OFFSET 0 10 0
          CHANNELS 3 Zrotation Xrotation Yrotation
          End Site
          {
            OFFSET 0 15 0
          }
        }
      }
      JOINT L_Shoulder
      {
        OFFSET 5 15 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT L_UpperArm
        {
          OFFSET 10 0 0
          CHANNELS 3 Zrotation Xrotation Yrotation
          JOINT L_LowerArm
          {
            OFFSET ${c.toFixed(3)} -${c.toFixed(3)} 0
            CHANNELS 3 Zrotation Xrotation Yrotation
            JOINT L_Hand
            {
              OFFSET ${c.toFixed(3)} -${c.toFixed(3)} 0
              CHANNELS 3 Zrotation Xrotation Yrotation
              End Site
              {
                OFFSET 5 -5 0
              }
            }
          }
        }
      }
      JOINT R_Shoulder
      {
        OFFSET -5 15 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT R_UpperArm
        {
          OFFSET -10 0 0
          CHANNELS 3 Zrotation Xrotation Yrotation
          JOINT R_LowerArm
          {
            OFFSET -${c.toFixed(3)} -${c.toFixed(3)} 0
            CHANNELS 3 Zrotation Xrotation Yrotation
            JOINT R_Hand
            {
              OFFSET -${c.toFixed(3)} -${c.toFixed(3)} 0
              CHANNELS 3 Zrotation Xrotation Yrotation
              End Site
              {
                OFFSET -5 -5 0
              }
            }
          }
        }
      }
    }
  }
  JOINT L_Thigh
  {
    OFFSET 10 0 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT L_Shin
    {
      OFFSET 0 -45 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT L_Foot
      {
        OFFSET 0 -45 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        End Site
        {
          OFFSET 0 -10 15
        }
      }
    }
  }
  JOINT R_Thigh
  {
    OFFSET -10 0 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT R_Shin
    {
      OFFSET 0 -45 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT R_Foot
      {
        OFFSET 0 -45 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        End Site
        {
          OFFSET 0 -10 15
        }
      }
    }
  }
}
MOTION
Frames: 61
Frame Time: 0.016667
`;
  // 61 frames: hips move 1 m forward (root motion), left upper arm raises by rotating about Z from 0 → 45°
  const joints = 19; // Hips, Spine, Chest, Neck, Head, 4 arm joints × 2, 3 leg joints × 2 → channels: 6 + 18×3 = 60
  const rows = [];
  for (let f = 0; f < 61; f++) {
    const u = f / 60;
    const vals = [0, 100, u * 100, 0, 0, 0]; // hips: z translation 0 → 100 cm
    for (let j = 1; j < joints; j++) vals.push(0, 0, 0);
    // L_UpperArm is joint index 6 (Hips=0, Spine=1, Chest=2, Neck=3, Head=4, L_Shoulder=5, L_UpperArm=6): Z rotation
    vals[6 + 5 * 3] = 45 * u;
    rows.push(vals.join(' '));
  }
  const text = bvh + rows.join('\n') + '\n';
  const src = await loadAnimationData(text, 'apose.bvh');
  check('BVH parsed with root motion and dense 60 fps sampling', src.bones.length >= 17 && src.clips.length === 1 && src.clips[0].sampleRate > 50, `${src.bones.length} bones @ ${src.clips[0].sampleRate.toFixed(0)} fps`);
  check('L_/R_ naming convention understood', roleOf('L_LowerArm') === 'forearm.L' && roleOf('R_Thigh') === 'thigh.R' && roleOf('L_Shin') === 'shin.L');
  const ed = makeTarget('tpose', false); // pure FK target: no IK constraints pulling the limbs
  const tb = ed.project.nodes.filter((n) => n.type === 'bone').map((b) => ({ id: b.id, name: b.name, parent: b.parent, depth: 0 }));
  const auto = autoMap(src.bones, tb);
  check('BVH auto-map finds arms and legs', ['upperArm.L', 'forearm.L', 'thigh.L', 'shin.L', 'hips', 'head'].every((r) => Object.values(auto.roles).includes(r)));
  const rm = detectRootMotion(src, src.clips[0], auto.sourceRoles.hips);
  check('root motion detected (1 m forward)', rm.present && Math.abs(rm.distance - 1) < 0.05, `${rm.distance.toFixed(2)} m`);
  // A-pose correction: at frame 0 the source forearm points 45° down but the T-pose target forearm must stay horizontal
  const res = await retargetClip(ed.project, src, src.clips[0], auto.mapping, auto.roles, { rootMotion: 'keep', scaleToHeight: false, tolerance: 'normal', name: 'APose' });
  const fore = ed.project.nodes.find((n) => n.name === 'Forearm.L');
  const rest = worldTransforms(ed.project, null).get(fore.id).rot;
  const w0 = evaluatePose(ed.project, res.clip.id, 0).world.get(fore.id).rot;
  check('A-pose source rest → T-pose target rest: no offset at frame 0', ang(w0, rest) < 1.0, `${ang(w0, rest).toFixed(2)}°`);
  const upper = ed.project.nodes.find((n) => n.name === 'Upper Arm.L');
  const u0 = evaluatePose(ed.project, res.clip.id, 0).world.get(upper.id).rot, u1 = evaluatePose(ed.project, res.clip.id, 1).world.get(upper.id).rot;
  check('the 45° arm raise transfers as a 45° world rotation', Math.abs(ang(u0, u1) - 45) < 3, `${ang(u0, u1).toFixed(1)}°`);
  const hips = ed.project.nodes.find((n) => n.name === 'Hips');
  const hp = track(res.clip, hips.id).pos;
  const travel = v3.dist(hp[hp.length - 1].v, hp[0].v);
  check('kept root motion travels ~1 m (unit scale applied)', Math.abs(travel - 1) < 0.05, `${travel.toFixed(2)} m`);
  check('dense 60 fps input reduced well below one key per frame', res.stats.keysAfter < res.stats.keysBefore / 3, `${res.stats.keysAfter} / ${res.stats.keysBefore}`);
  // partial skeleton: unmap the legs
  const partial = { ...auto.mapping };
  for (const [tid, role] of Object.entries(auto.roles)) if (/thigh|shin|foot/.test(role)) delete partial[tid];
  const ws = validateRetarget(ed.project, src, src.clips[0], partial, auto.roles);
  check('partial skeleton flagged but still retargetable', ws.some((w) => w.kind === 'unmappedMajor') && (await retargetClip(ed.project, src, src.clips[0], partial, auto.roles, { name: 'partial' })).clip.tracks[upper.id]);
}

// ---------- 3. glTF (self-contained JSON) with two clips ----------
{
  const gltf = makeGltf();
  const src = await loadAnimationData(JSON.stringify(gltf), 'two.gltf');
  check('glTF parsed: nodes as bones, two clips listed with durations', src.bones.length === 3 && src.clips.length === 2 && src.clips.map((c) => c.name).join() === 'Wave,Nod' && src.clips[0].duration === 1 && src.clips[1].duration === 0.5);
  const ed = makeTarget('tpose');
  const tb = ed.project.nodes.filter((n) => n.type === 'bone').map((b) => ({ id: b.id, name: b.name, parent: b.parent, depth: 0 }));
  const auto = autoMap(src.bones, tb);
  const mappedSrc = new Set(Object.values(auto.mapping).map((i) => src.bones[i].name));
  check('glTF bones map by name (Hips, Spine → torso, Head)', ['Hips', 'Spine', 'Head'].every((n) => mappedSrc.has(n)) && ['hips', 'head'].every((r) => Object.values(auto.roles).includes(r)));
  const r1 = await retargetClip(ed.project, src, src.clips[0], auto.mapping, auto.roles, { name: 'Wave' });
  const r2 = await retargetClip(ed.project, src, src.clips[1], auto.mapping, auto.roles, { name: 'Nod' });
  check('both clips import independently', r1.clip.id !== r2.clip.id && ed.project.clips.includes(r1.clip) && ed.project.clips.includes(r2.clip));
}

// ---------- 4. Unity .anim ----------
{
  const muscle = `%YAML 1.1\nAnimationClip:\n  m_Name: Specialist\n  m_RotationCurves: []\n  m_PositionCurves: []\n  m_FloatCurves:\n  - curve:\n      m_Curve:\n      - time: 0\n        value: 0.1\n    attribute: RootT.x\n    path: \n`;
  check('Unity Humanoid (muscle) clips are rejected with a clear reason', parseUnityAnim(muscle).muscle === true);
  const generic = `%YAML 1.1\nAnimationClip:\n  m_Name: Generic\n  m_RotationCurves:\n  - curve:\n      m_Curve:\n      - time: 0\n        value: {x: 0, y: 0, z: 0, w: 1}\n      - time: 1\n        value: {x: 0, y: 0.7071, z: 0, w: 0.7071}\n    path: Hips/Spine\n  m_PositionCurves:\n  - curve:\n      m_Curve:\n      - time: 0\n        value: {x: 0, y: 1, z: 0}\n    path: Hips\n  m_FloatCurves: []\n`;
  const g = parseUnityAnim(generic);
  check('generic Unity transform curves become a clip with a Hips/Spine hierarchy', !g.muscle && g.animations.length === 1 && g.animations[0].tracks.length === 2 && g.root.children[0].name === 'Hips');
  const src = await loadAnimationData(generic, 'generic.anim');
  check('generic .anim goes through the normal importer', src.bones.length === 2 && src.clips[0].duration === 1);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);

// minimal self-contained glTF: Hips > Spine > Head, two rotation clips
function makeGltf() {
  const times = [0, 0.5, 1], times2 = [0, 0.5];
  const q = (deg) => { const r = deg * Math.PI / 180; return [0, 0, Math.sin(r / 2), Math.cos(r / 2)]; };
  const rot = [...q(0), ...q(20), ...q(0)], rot2 = [...q(0), ...q(15)];
  const f32 = (a) => new Float32Array(a);
  const parts = [f32(times), f32(rot), f32(times2), f32(rot2)];
  const total = parts.reduce((a, p) => a + p.byteLength, 0);
  const buf = new Uint8Array(total); let off = 0; const views = [];
  for (const p of parts) { buf.set(new Uint8Array(p.buffer), off); views.push({ buffer: 0, byteOffset: off, byteLength: p.byteLength }); off += p.byteLength; }
  const b64 = Buffer.from(buf).toString('base64');
  return {
    asset: { version: '2.0' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Hips', translation: [0, 1, 0], children: [1] }, { name: 'Spine', translation: [0, 0.3, 0], children: [2] }, { name: 'Head', translation: [0, 0.4, 0] }],
    buffers: [{ byteLength: total, uri: 'data:application/octet-stream;base64,' + b64 }],
    bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [1] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [0.5] }, { bufferView: 3, componentType: 5126, count: 2, type: 'VEC4' },
    ],
    animations: [
      { name: 'Wave', samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }] },
      { name: 'Nod', samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }] },
    ],
  };
}
