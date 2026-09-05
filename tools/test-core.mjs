// Core pipeline checks (no browser): node tools/test-core.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importGia } from '../js/gia/gia-import.js';
import { exportGia } from '../js/gia/gia-export.js';
import { parseGia, collectObjects, collectGraphs } from '../js/gia/gia-file.js';
import { quat, v3, gameEulerToDisplayQuat, displayQuatToGameEuler, gameToDisplayPos, displayToGamePos } from '../js/core/math.js';
import { createProject, createNode, reparent, worldTransforms } from '../js/scene/scene.js';
import { createClip, insertKey } from '../js/anim/clips.js';
import { createConstraint } from '../js/anim/ik.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { bakeClip } from '../js/anim/bake.js';
import { validateProject, hasErrors } from '../js/validation.js';

const here = dirname(fileURLToPath(import.meta.url));
const R = join(here, '..', 'References');
const load = (f) => new Uint8Array(readFileSync(join(R, f)));
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

// --- math round trips
{
  const e = { x: 12.5, y: -80, z: 33 };
  const q = gameEulerToDisplayQuat(e);
  const back = displayQuatToGameEuler(q);
  check('euler ↔ quat round trip', near(back.x, e.x) && near(back.y, e.y) && near(back.z, e.z), JSON.stringify(back));
  const p = gameToDisplayPos({ x: 1, y: 2, z: 3 });
  const pb = displayToGamePos(p);
  check('pos round trip', pb.x === 1 && pb.y === 2 && pb.z === 3);
  // composition consistency: rotating +Z (game forward) by yaw 90 → +X in game
  const qy = quat.fromEulerYXZ(0, Math.PI / 2, 0);
  const r = quat.rotate(qy, [0, 0, 1]);
  check('Ry(90) maps +Z to +X', near(r[0], 1) && near(r[2], 0), r.map((v) => v.toFixed(3)).join(','));
}

// --- import
const { project: p1, info: i1 } = importGia(load('Bangboo.gia'), 'Bangboo.gia');
check('import Bangboo objects', i1.objects === 10 && i1.decorations === 88, `${i1.objects} objects, ${i1.decorations} decorations`);
const { project: p2, info: i2 } = importGia(load('Bangboo With Body Path Movement 2 Points.gia'), 'b2.gia');
check('import motion device → clip', p2.clips.length === 1 && p2.clips[0].name === 'Example Animation' && p2.clips[0].loop, JSON.stringify(i2.importedClips));
const body2 = p2.nodes.find((n) => n.name === 'Body');
const tr = p2.clips[0].tracks[body2.id];
check('imported clip keys', tr && tr.pos.length === 3 && tr.rot.length === 3 && near(p2.clips[0].duration, 2), `duration ${p2.clips[0].duration}`);
const { info: i3 } = importGia(load('Bangboo With Body Path Movement 2 Points With Master Script.gia'), 'b3.gia');
check('controller detected and skipped', i3.controllerFound && i3.objects === 10);

// --- reparent keeps world
{
  const p = createProject();
  const a = createNode(p, 'bone', { name: 'A', pos: [1, 0, 0], rot: quat.fromEulerDeg([0, 90, 0]) });
  const b = createNode(p, 'proxy', { name: 'B', pos: [0, 2, 3], rot: quat.fromEulerDeg([30, 0, 0]) });
  const w0 = worldTransforms(p).get(b.id);
  reparent(p, b.id, a.id);
  const w1 = worldTransforms(p).get(b.id);
  check('reparent preserves world', v3.eq(w0.pos, w1.pos, 1e-6) && quat.angle(w0.rot, w1.rot) < 1e-6, `${w0.pos} vs ${w1.pos}`);
  reparent(p, b.id, null);
  const w2 = worldTransforms(p).get(b.id);
  check('unparent preserves world', v3.eq(w0.pos, w2.pos, 1e-6) && quat.angle(w0.rot, w2.rot) < 1e-6);
}

// --- IK reaches target
{
  const p = createProject();
  const root = createNode(p, 'bone', { name: 'upper', pos: [0, 1, 0], length: 0.5 });
  const mid = createNode(p, 'bone', { name: 'lower', parent: root.id, pos: [0, 0.5, 0], length: 0.5 });
  const target = createNode(p, 'target', { name: 't', pos: [0.4, 1.3, 0.3] });
  const pole = createNode(p, 'pole', { name: 'p', pos: [0, 1.5, 1] });
  createConstraint(p, mid.id, target.id, { poleId: pole.id, chainLength: 2 });
  const { world } = evaluatePose(p, null, 0);
  const tipW = world.get(mid.id);
  const tail = v3.add(tipW.pos, quat.rotate(tipW.rot, [0, mid.length, 0]));
  check('IK tip reaches target', v3.dist(tail, target.pos) < 1e-3, `tail ${tail.map((v) => v.toFixed(3))}`);
  // knee toward pole side (+Z)
  const knee = world.get(mid.id).pos;
  check('pole bends chain toward pole', knee[2] > 0, `knee z ${knee[2].toFixed(3)}`);
}

// --- bake: linear motion collapses to one segment, direction change splits
{
  const p = createProject();
  const o = createNode(p, 'object', { name: 'O', guid: 1, zoom: [0.1, 0.1, 0.1] });
  const c = createClip(p, 'Walk', 2);
  insertKey(c, o.id, 'pos', 0, [0, 0, 0]);
  insertKey(c, o.id, 'pos', 0.7, [0.7, 0, 0]); // same velocity → mergeable
  insertKey(c, o.id, 'pos', 2, [2, 0, 0]);
  const b1 = bakeClip(p, c).points.get(o.id);
  check('collinear constant-speed keys → 1 segment', b1.moves && b1.points.length === 1, `${b1.points.length} points`);
  insertKey(c, o.id, 'pos', 2, [2, 0, 1]); // change direction at 0.7
  const b2 = bakeClip(p, c).points.get(o.id);
  check('direction change → 2 segments at key time', b2.points.length === 2 && near(b2.points[0].t, 0.7, 0.02), b2.points.map((q) => q.t.toFixed(3)).join(','));
  insertKey(c, o.id, 'pos', 0, [0, 0, 0], 'ease');
  const b3 = bakeClip(p, c).points.get(o.id);
  check('eased segment gets subdivided', b3.points.length > 3, `${b3.points.length} points`);
  // rotation-only motion
  const c2 = createClip(p, 'Spin', 1);
  insertKey(c2, o.id, 'rot', 0, quat.identity());
  insertKey(c2, o.id, 'rot', 1, quat.fromEulerDeg([0, 90, 0]));
  const b4 = bakeClip(p, c2).points.get(o.id);
  check('uniform rotation → 1 segment', b4.moves && b4.points.length === 1, `${b4.points.length}`);
}

// --- export the imported 2-point clip → device points equal the sample's
{
  const src = load('Bangboo With Body Path Movement 2 Points.gia');
  const { project } = importGia(src, 'b2.gia');
  const clip = project.clips[0];
  project.exportConfig.slots = [{ clipId: clip.id, name: 'Example Animation', outputYaw: 0 }];
  const issues = validateProject(project, src);
  check('validation has no errors', !hasErrors(issues), issues.map((i) => i.level + ':' + i.key).join(' '));
  const { bytes, report } = exportGia(project, src);
  const doc = parseGia(bytes);
  const objs = collectObjects(doc);
  const body = objs.find((o) => o.name === 'Body');
  const dev = body.motionDevices[0];
  check('exported Body has 1 device with 2 points', dev && dev.points.length === 2 && dev.motionType === 1002, JSON.stringify(dev?.points?.map((q) => [q.pos, q.rot, q.duration])));
  const p2 = dev?.points?.[1];
  check('waypoint 2 matches sample', p2 && near(p2.pos.x, 2.1902, 2e-3) && near(p2.pos.z, 1.4417, 2e-3) && near(p2.rot.z, 35.0948, 0.05) && near(p2.duration, 1, 1e-3), p2 && JSON.stringify(p2));
  const ctrl = objs.find((o) => o.name === 'Animator Controller');
  check('controller present with Parts', ctrl && ctrl.customVariables?.find((v) => v.name === 'Parts')?.guidList?.length === 1, JSON.stringify(ctrl?.customVariables));
  const graphs = collectGraphs(doc);
  check('graph present', graphs.length === 1 && graphs[0].nodeCount === 13, JSON.stringify(graphs.map((g) => [g.name, g.nodeCount])));
  const others = objs.filter((o) => o.name !== 'Body' && o.name !== 'Animator Controller');
  check('non-moving objects untouched', others.every((o) => o.motionDevices.length === 0) && others.length === 9);
  const outDir = join(here, '..', 'tmp');
  try { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, 'export-test.gia'), bytes); } catch {}
  // re-import the export: must round trip into the same clip
  const again = importGia(bytes, 'x.gia');
  check('re-import of export', again.info.controllerFound && again.project.clips.length === 1 && again.project.clips[0].tracks[again.project.nodes.find((n) => n.name === 'Body').id].pos.length === 3);
  // export twice: no duplicate controller
  const twice = exportGia(again.project, bytes);
  const objs2 = collectObjects(parseGia(twice.bytes));
  check('re-export replaces controller (no duplicates)', objs2.filter((o) => o.name === 'Animator Controller').length === 1 && collectGraphs(parseGia(twice.bytes)).length === 1);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
