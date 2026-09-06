// Miliastra advertises 50 path movement points per Linear Motion Device path, but its
// limit check is unreliable at 50: the editor's safe maximum is 49 (MAX_PATH_POINTS).
// Export validation counts the FINAL serialized points, stops the export when a
// path exceeds the limit, and automatic compression reduces paths while keeping
// the motion.   node tools/test-path-limit.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { buildExportPlan, pathLimitViolations, compressPlan, exportGia, MAX_PATH_POINTS } from '../js/gia/gia-export.js';
import { compressPath, simplifyPolyline, ACCEPTABLE_ERROR } from '../js/anim/path-compress.js';
import { parseGia, collectObjects } from '../js/gia/gia-file.js';
import { createClip, insertKey } from '../js/anim/clips.js';
import { createNode } from '../js/scene/scene.js';
import { quat, v3 } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const white = readFileSync(new URL('./fixtures/White Square.gia', import.meta.url));

// editor with the one-object fixture and a clip driven by `keys(t) → pos` samples at times `ts`
function setup(clipName = 'A') {
  const ed = new Editor();
  ed.importGia(white, 'White Square.gia');
  ed.project.exportConfig.slots = [];
  const obj = ed.project.nodes.find((n) => n.type === 'object');
  return { ed, obj };
}
function addClip(ed, obj, name, samples, { rot = null, loop = false } = {}) {
  const clip = createClip(ed.project, name, Math.max(...samples.map((s) => s.t)) || 1);
  clip.loop = loop;
  for (const s of samples) { insertKey(clip, obj.id, 'pos', s.t, s.pos); if (s.rot || rot) insertKey(clip, obj.id, 'rot', s.t, s.rot || rot); }
  ed.project.exportConfig.slots.push({ clipId: clip.id, name, outputYaw: 0 });
  ed.project.activeClipId = ed.project.activeClipId || clip.id;
  return clip;
}
// a zigzag with n corners (each key is a sharp corner → one exported point per key interval)
const zigzag = (n, amp = 0.5, dt = 0.1) => Array.from({ length: n + 1 }, (_, i) => ({ t: i * dt, pos: [i % 2 ? amp : -amp, 0, i * 0.2] }));
const exportedCounts = (ed, plan) => {
  const { bytes } = exportGia(ed.project, ed.giaBytes, { plan });
  const o = collectObjects(parseGia(bytes)).find((x) => x.motionDevices?.length);
  return o ? o.motionDevices.map((d) => d.points.length) : [];
};
const planCounts = (plan) => plan.devices.map((d) => d.points.length);

// ---------- 1. exact counts around the limit ----------
check('the safe maximum is 49 points', MAX_PATH_POINTS === 49);
for (const n of [1, 48, 49, 50, 51, 120]) {
  const { ed, obj } = setup();
  addClip(ed, obj, 'zig' + n, zigzag(n));
  const plan = buildExportPlan(ed.project, ed.giaBytes);
  const count = planCounts(plan)[0];
  const over = pathLimitViolations(plan);
  check(`${n} corner(s): the plan counts ${n} final point(s)`, count === n, `${count}`);
  if (n <= MAX_PATH_POINTS) {
    check(`${n} points: no violation, exports normally with ${n} point(s)`, over.length === 0 && exportedCounts(ed)[0] === n);
  } else {
    check(`${n} points: violation reported (count ${n}, max ${MAX_PATH_POINTS})`, over.length === 1 && over[0].count === n && over[0].max === MAX_PATH_POINTS && over[0].clipName === 'zig' + n);
    let threw = null; try { exportGia(ed.project, ed.giaBytes); } catch (e) { threw = e; }
    check(`${n} points: serialization refuses an over-limit plan (no silent truncation)`, threw?.code === 'pathLimit');
  }
}

// ---------- 2. hundreds of baked points (curved motion) → compression reaches the limit ----------
{
  const { ed, obj } = setup();
  // a smooth 3D curve sampled every frame: the baker keeps many segments at normal precision
  const samples = Array.from({ length: 301 }, (_, i) => { const t = i / 30; return { t, pos: [Math.sin(t * 1.3) * 1.5, 0.5 + Math.cos(t * 0.7) * 0.4, t * 0.3] }; });
  addClip(ed, obj, 'curve', samples);
  const plan = buildExportPlan(ed.project, ed.giaBytes);
  const raw = planCounts(plan)[0];
  check('dense baked curve exceeds the limit', raw > MAX_PATH_POINTS, `${raw}`);
  const before = JSON.stringify(ed.project);
  const { plan: cp, results, ok } = compressPlan(plan);
  check('curve: compression reaches ≤ 49 within the acceptable error', ok && results[0].after <= MAX_PATH_POINTS && results[0].maxError.pos <= ACCEPTABLE_ERROR.pos, JSON.stringify(results[0]));
  check('curve: compression keeps the total duration', Math.abs(cp.devices[0].points.reduce((a, p) => a + p.duration, 0) - plan.devices[0].points.reduce((a, p) => a + p.duration, 0)) < 1e-6);
  check('curve: start and end points preserved', v3.dist(cp.devices[0].points[0].pos, plan.devices[0].points[0].pos) < 1e-9 && v3.dist(cp.devices[0].points.at(-1).pos, plan.devices[0].points.at(-1).pos) < 1e-9);
  check('compression never modifies the project', JSON.stringify(ed.project) === before);
  const counts = exportedCounts(ed, cp);
  check('curve: the exported file contains ≤ 49 points', counts.every((c) => c <= MAX_PATH_POINTS) && counts[0] === results[0].after, counts.join());
  // the compressed path stays close to the original motion at every original sample time
  const orig = plan.devices[0].points, comp = cp.devices[0].points;
  let T = 0; const times = orig.map((p) => (T += p.duration));
  let Tc = 0; const ctimes = comp.map((p) => (Tc += p.duration));
  let worst = 0;
  orig.forEach((p, i) => { const t = times[i]; let j = ctimes.findIndex((ct) => ct >= t - 1e-9); if (j <= 0) return; const u = (t - ctimes[j - 1]) / (ctimes[j] - ctimes[j - 1]); worst = Math.max(worst, v3.dist(p.pos, v3.lerp(comp[j - 1].pos, comp[j].pos, u))); });
  check('curve: compressed path deviates < 5 cm from the original at every original sample', worst <= ACCEPTABLE_ERROR.pos + 1e-9, `${(worst * 100).toFixed(2)} cm`);
}

// ---------- 3. motion features that compression must keep ----------
{
  // straight line: one segment
  const { ed, obj } = setup();
  addClip(ed, obj, 'line', [{ t: 0, pos: [0, 0, 0] }, { t: 2, pos: [0, 0, 3] }]);
  check('straight-line movement exports as a single point', planCounts(buildExportPlan(ed.project, ed.giaBytes))[0] === 1);
}
{
  // sharp turns: an 80-corner zigzag of 1 m amplitude cannot lose any corner without a ≥ 1 m error
  const { ed, obj } = setup();
  addClip(ed, obj, 'sharp', zigzag(80, 1.0));
  const plan = buildExportPlan(ed.project, ed.giaBytes);
  const { results, ok } = compressPlan(plan);
  check('sharp turns: every corner matters, compression reports it cannot reach 49 safely', !ok && results[0].reached && results[0].maxError.pos > ACCEPTABLE_ERROR.pos, JSON.stringify(results[0]));
  let threw = null; try { exportGia(ed.project, ed.giaBytes); } catch (e) { threw = e; }
  check('sharp turns: nothing is exported unchanged', threw?.code === 'pathLimit');
}
{
  // vertical movement with a plateau in the middle (pause): the pause boundaries survive
  const pts = [{ pos: [0, 0, 0], duration: 0 }, { pos: [0, 1, 0], duration: 1 }, { pos: [0, 1, 0], duration: 1 }, { pos: [0, 2, 0], duration: 1 }];
  const dense = [];
  for (let i = 1; i < pts.length; i++) for (let k = 1; k <= 10; k++) { const u = k / 10; dense.push({ pos: v3.lerp(pts[i - 1].pos, pts[i].pos, u), duration: pts[i].duration / 10 }); }
  const path = [{ pos: [0, 0, 0], duration: 0 }, ...dense];
  const r = compressPath(path, { maxPoints: 5 });
  check('vertical movement with a pause compresses to the 4 defining points', r.after === 4 && r.ok && r.points.map((p) => p.pos[1].toFixed(2)).join() === '0.00,1.00,1.00,2.00', r.points.map((p) => p.pos[1].toFixed(2) + '@' + p.duration.toFixed(2)).join(' '));
  check('pause timing preserved (1 s hold)', Math.abs(r.points[2].duration - 1) < 1e-9 && Math.abs(r.points.reduce((a, p) => a + p.duration, 0) - 3) < 1e-9);
}
{
  // variable speed on a straight line: fast 2 m in 0.5 s then slow 2 m in 3 s — the speed change survives
  const path = [{ pos: [0, 0, 0], duration: 0 }];
  for (let k = 1; k <= 20; k++) path.push({ pos: [0, 0, 2 * k / 20], duration: 0.5 / 20 });
  for (let k = 1; k <= 20; k++) path.push({ pos: [0, 0, 2 + 2 * k / 20], duration: 3 / 20 });
  const r = compressPath(path, { maxPoints: 3 });
  check('variable-speed straight path keeps the speed-change point, not a constant-speed line', r.after === 3 && Math.abs(r.points[1].pos[2] - 2) < 1e-9 && Math.abs(r.points[1].duration - 0.5) < 1e-9 && Math.abs(r.points[2].duration - 3) < 1e-9 && r.ok);
  const r2 = compressPath(path, { maxPoints: 2 });
  check('forcing it to 2 points reports the timing error as unacceptable', r2.after === 2 && !r2.ok && r2.maxError.pos > ACCEPTABLE_ERROR.pos);
}
{
  // rotation change on a straight, constant-speed line: collinear position but a 90° yaw flip mid-way must survive
  const q0 = [0, 0, 0, 1], q1 = quat.fromEulerDeg([0, 90, 0]);
  const path = [{ pos: [0, 0, 0], rot: q0, duration: 0 }];
  for (let k = 1; k <= 30; k++) path.push({ pos: [0, 0, k / 10], rot: k < 15 ? q0 : q1, duration: 0.1 });
  const r = compressPath(path, { maxPoints: 10 });
  const keptRotFlip = r.points.some((p, i) => i > 0 && quat.angle(r.points[i - 1].rot, p.rot) > 1 && Math.abs(p.pos[2] - 1.5) < 1e-9) && r.points.some((p) => Math.abs(p.pos[2] - 1.4) < 1e-9);
  check('an orientation change on a collinear path is kept (points before and at the flip)', r.ok && r.after <= 10 && keptRotFlip, r.points.map((p) => p.pos[2].toFixed(1)).join(' '));
  const rp = compressPath(path.map((p) => ({ ...p, rot: q0 })), { maxPoints: 10 });
  check('the same path without the rotation change collapses to 2 points', rp.after === 2 && rp.ok);
}

// ---------- 4. multiple paths, only some over the limit ----------
{
  const { ed, obj } = setup();
  const obj2 = createNode(ed.project, 'object', { name: 'second', pos: [1, 0, 0], guid: obj.guid + 1 });
  void obj2; // objects without a file entry are not exported; use two clips instead
  addClip(ed, obj, 'short', zigzag(10));
  const samples = Array.from({ length: 241 }, (_, i) => { const t = i / 30; return { t, pos: [Math.sin(t) * 1.2, 0, Math.cos(t * 0.8) * 1.2] }; });
  addClip(ed, obj, 'long', samples);
  addClip(ed, obj, 'exact49', zigzag(49));
  addClip(ed, obj, 'fifty', zigzag(50, 0.01)); // exactly 50 gentle corners: over the safe limit, safely compressible
  const plan = buildExportPlan(ed.project, ed.giaBytes);
  const over = pathLimitViolations(plan);
  check('four animations: only the over-limit paths (dense curve, exactly 50) are reported', over.length === 2 && over.map((o) => o.clipName).join() === 'long,fifty' && over[0].count > MAX_PATH_POINTS && over[1].count >= 50, JSON.stringify(over.map((o) => [o.clipName, o.count])));
  const { plan: cp, results, ok } = compressPlan(plan);
  check('compression processes only the affected paths and reports them individually', ok && results.length === 2 && results.every((r) => r.after <= MAX_PATH_POINTS) && results.find((r) => r.clipName === 'fifty').after <= 49);
  const keep = (d) => d.clipName !== 'long' && d.clipName !== 'fifty';
  const untouched = cp.devices.filter(keep).every((d, i) => d.points === plan.devices.filter(keep)[i].points);
  check('the other paths are passed through unchanged (exactly 49 stays 49)', untouched && cp.devices.find((d) => d.clipName === 'exact49').points.length === 49);
  const counts = exportedCounts(ed, cp);
  check('exported file: every device ≤ 49 points', counts.length === 4 && counts.every((c) => c <= MAX_PATH_POINTS) && counts[2] === 49 && counts[3] <= 49, counts.join());
}

// ---------- 5. editor flow: cancel never changes the project; remember = undoable slot setting ----------
{
  const { ed, obj } = setup();
  const samples = Array.from({ length: 301 }, (_, i) => { const t = i / 30; return { t, pos: [Math.sin(t * 1.3) * 1.5, 0.5 + Math.cos(t * 0.7) * 0.4, t * 0.3] }; });
  addClip(ed, obj, 'curve', samples);
  ed.history.reset(ed.snapshotState());
  const before = JSON.stringify(ed.snapshotState());
  let seen = null;
  ed.resolvePathLimit = async (plan, over) => { seen = over; return null; }; // the user cancels
  const r = await ed.exportFile();
  check('export stops with the violation list and cancel leaves the project untouched', r === null && seen?.length === 1 && JSON.stringify(ed.snapshotState()) === before && ed.history.undoStack.length === 0);
  // compress + remember: the slot gets the persisted auto-compress flag (one undo step); the animation itself is untouched
  ed.resolvePathLimit = async (plan) => ({ plan: compressPlan(plan).plan, remember: true });
  const r2 = await ed.exportFile();
  check('compress & export succeeds with ≤ 49 points and records the compression in the report', !!r2 && r2.parts[0].points[0] <= MAX_PATH_POINTS && r2.compressed.length === 1);
  check('"remember" turned on auto-compress for the slot as one undoable step; clip keys unchanged', ed.slots[0].compress === true && ed.history.undoStack.length === 1 && JSON.stringify(ed.project.clips) === JSON.stringify(JSON.parse(before).project.clips));
  ed.undo();
  check('undo restores the slot setting exactly', JSON.stringify(ed.snapshotState()) === before);
  ed.redo();
  // with auto-compress on, the plan is already within the limit and export proceeds without the dialog
  let asked = false;
  ed.resolvePathLimit = async () => { asked = true; return null; };
  const r3 = await ed.exportFile();
  check('auto-compress slot: export proceeds without prompting, ≤ 49 points', !asked && !!r3 && r3.parts[0].points[0] <= MAX_PATH_POINTS);
}

// ---------- 6. manual simplification of a waypath ----------
{
  const { ed } = setup();
  const wp = ed.addWaypath('manual');
  const pts = []; for (let i = 0; i <= 40; i++) pts.push([i * 0.1, 0, i < 20 ? 0 : (i - 20) * 0.1]); // an L with 41 samples
  ed.updateWaypath(wp.id, { points: pts });
  const preview = simplifyPolyline(pts, 0.01);
  check('simplify preview: 41 → 3 points (start, corner, end)', preview.after === 3 && preview.before === 41);
  const before = JSON.stringify(ed.project);
  const r = ed.simplifyWaypath(wp.id, 0.01);
  check('Simplify path applies as one undoable step', r.after === 3 && ed.project.waypaths[0].points.length === 3 && ed.history.undoLabel() === 'Simplify path');
  ed.undo();
  check('undo restores the 41 points', JSON.stringify(ed.project) === before);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
