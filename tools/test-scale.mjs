// Scale Entire Model: the complete assembly (objects, decorations via zoom, display offsets,
// bones, IK, poles, keys, root motion, waypaths) resizes as one unit about the model pivot;
// rotations and timing are unchanged; the per-object scale limit of 50 is validated before
// committing and before export.   node tools/test-scale.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { createNode, worldTransforms, getNode } from '../js/scene/scene.js';
import { createClip, insertKey } from '../js/anim/clips.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { exportGia, exportPivot, buildExportPlan, objectScaleViolations, MAX_OBJECT_SCALE } from '../js/gia/gia-export.js';
import { parseGia, collectObjects } from '../js/gia/gia-file.js';
import { importGia } from '../js/gia/gia-import.js';
import { validateProject, hasErrors } from '../js/validation.js';
import { quat, v3, gameToDisplayPos } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const pantalone = readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url));
const white = readFileSync(new URL('./fixtures/White Square.gia', import.meta.url));
const scaled = (w, piv, S) => ({ pos: v3.add(piv, v3.scale(v3.sub(w.pos, piv), S)), rot: w.rot });
const same = (a, b, eps = 1e-6) => v3.dist(a.pos, b.pos) < eps && quat.angle(a.rot, b.rot) < eps;

// ---------- 1. rigged model with IK, poles, animation, root motion, waypath, global offset, correction ----------
for (const S of [0.25, 0.5, 2, 10, 1.37]) {
  const ed = new Editor();
  ed.importGia(pantalone, 'Pantalone.gia');
  ed.project.settings.globalOffset = [1, 0, -2];
  ed.applyAutoRig(ed.proposeAutoRig({ ik: true }));
  const hips = ed.project.nodes.find((n) => n.type === 'bone' && n.name === 'Hips');
  const neck = ed.project.nodes.find((n) => n.type === 'bone' && n.name === 'Neck');
  const someObj = ed.project.nodes.find((n) => n.type === 'object');
  someObj.correction = [0, 0, 15];
  const wp = ed.addWaypath('manual');
  ed.createClip('walk');
  const clip = ed.project.clips[0];
  insertKey(clip, hips.id, 'pos', 0, hips.pos); insertKey(clip, hips.id, 'pos', 2, v3.add(hips.pos, [0, 0, 1]));
  insertKey(clip, neck.id, 'rot', 0, neck.rot, 'linear', [0, 0, 0]); insertKey(clip, neck.id, 'rot', 1, quat.fromEulerDeg([0, 40, 0]), 'linear', [0, 40, 0]);
  ed.project.exportConfig.slots = [{ clipId: clip.id, name: 'walk', outputYaw: 90 }];
  ed.history.reset(ed.snapshotState());
  const before = JSON.stringify(ed.snapshotState());
  const piv = exportPivot(ed.project);
  const travelOf = (plan, nodeId) => { const d = plan.devices.find((x) => x.nodeId === nodeId); const r0 = plan.rest.get(nodeId).pos; return v3.dist([r0[0], 0, r0[2]], [d.points.at(-1).pos[0], 0, d.points.at(-1).pos[2]]); };
  const plan0 = buildExportPlan(ed.project, ed.giaBytes);
  const devObj = plan0.devices[0]?.nodeId;
  const travel0 = devObj ? travelOf(plan0, devObj) : 0;
  const rest0 = evaluatePose(ed.project, null, 0).world;
  const anim0 = [0, 0.5, 1, 1.5, 2].map((t) => evaluatePose(ed.project, clip.id, t).world);
  const zoom0 = someObj.zoom.slice(), len0 = neck.length;
  const ok = ed.scaleModel(S);
  const rest1 = evaluatePose(ed.project, null, 0).world;
  check(`${S}×: every object, bone, IK target and pole sits at pivot + S·(old − pivot), rotations unchanged`, ok && ed.project.nodes.every((n) => same(rest1.get(n.id), scaled(rest0.get(n.id), piv, S), 1e-5 * Math.max(1, S))));
  check(`${S}×: object scale (zoom), bone length and the layout all scale by S`, getNode(ed.project, someObj.id).zoom.every((z, i) => Math.abs(z - zoom0[i] * S) < 1e-9) && Math.abs(getNode(ed.project, neck.id).length - len0 * S) < 1e-9);
  const distOk = ed.project.nodes.every((a) => ed.project.nodes.every((b) => Math.abs(v3.dist(rest1.get(a.id).pos, rest1.get(b.id).pos) - S * v3.dist(rest0.get(a.id).pos, rest0.get(b.id).pos)) < 1e-5 * Math.max(1, S)));
  check(`${S}×: distances between parts are multiplied by S (not individually enlarged in place)`, distOk);
  const animOk = [0, 0.5, 1, 1.5, 2].every((t, i) => ed.project.nodes.every((n) => same(evaluatePose(ed.project, clip.id, t).world.get(n.id), scaled(anim0[i].get(n.id), piv, S), 1e-5 * Math.max(1, S))));
  check(`${S}×: the animation (IK, rotations, root motion travel ${S} m) matches the resized model at every sampled time`, animOk);
  check(`${S}×: rotation keys untouched, position keys scaled`, clip.tracks[neck.id].rot[1].e[1] === 40 && Math.abs(v3.dist(clip.tracks[hips.id].pos[1].v, clip.tracks[hips.id].pos[0].v) - S) < 1e-9);
  check(`${S}×: waypath points scaled, timing kept`, v3.dist(ed.project.waypaths[0].points[1], [0, 0, 2 * S]) < 1e-9 && Math.abs(ed.project.waypaths[0].velocity - S) < 1e-9);
  check(`${S}×: correction and constraint weights untouched, modelScale metadata recorded`, getNode(ed.project, someObj.id).correction.join() === '0,0,15' && ed.project.constraints.every((k) => k.influence === undefined || k.influence === 1) && Math.abs(ed.project.modelScale - S) < 1e-9);
  // export: placement and device travel at the new size, object scale written, output rotation composes
  if (!objectScaleViolations(ed.project).length) {
    const { bytes } = exportGia(ed.project, ed.giaBytes);
    const out = collectObjects(parseGia(bytes));
    const restR = ed.constructor.name && (await import('../js/gia/gia-export.js')).exportPlacement(ed.project);
    const placeOk = ed.project.nodes.filter((n) => n.type === 'object' && n.guid != null).every((n) => { const o = out.find((x) => x.guid === n.guid); return o && v3.dist(gameToDisplayPos(o.transform.position), restR.get(n.id).pos) < 1e-4 && Math.abs(o.transform.zoom.x - n.zoom[0]) < 1e-6; });
    check(`${S}×: exported placement (with output rotation) and object scale reflect the new size`, placeOk);
    const plan = buildExportPlan(ed.project, ed.giaBytes);
    if (devObj) { const travel = travelOf(plan, devObj); check(`${S}×: exported Motion Device travel is ${S} × the unscaled travel (distances scaled, applied once)`, Math.abs(travel - S * travel0) < 1e-4 * Math.max(1, S), `${travel.toFixed(4)} vs ${(S * travel0).toFixed(4)}`); }
  } else check(`${S}×: oversized objects detected (${objectScaleViolations(ed.project).length}) — export refuses`, (() => { try { exportGia(ed.project, ed.giaBytes); return false; } catch (e) { return e.code === 'objectScale'; } })());
  check(`${S}×: one undo step restores everything exactly`, ed.history.undoLabel() === 'Scale entire model' && (ed.undo(), JSON.stringify(ed.snapshotState()) === before));
  ed.redo();
  check(`${S}×: redo reproduces the resized model`, ed.project.nodes.every((n) => same(evaluatePose(ed.project, null, 0).world.get(n.id), rest1.get(n.id), 1e-6)));
  // saved project reopens at the new size without re-applying anything
  const json = JSON.parse(JSON.stringify(ed.project));
  const ed2 = new Editor(); ed2.newProject(); ed2.applyRecord({ id: 'x', name: 'x', project: json, giaBytes: null });
  check(`${S}×: reopened project has the same size (metadata is not re-applied)`, ed2.project.nodes.every((n) => same(evaluatePose(ed2.project, null, 0).world.get(n.id), rest1.get(n.id), 1e-6)) && ed2.project.modelScale === ed.project.modelScale);
}

// ---------- 1b. decorations are never rewritten: only the parent object's scale changes ----------
{
  const ed = new Editor();
  ed.importGia(pantalone, 'Pantalone.gia');
  ed.createClip('a'); ed.project.exportConfig.slots = [{ clipId: ed.project.clips[0].id, name: 'a', outputYaw: 0 }];
  const dump = (bytes) => importGia(bytes, 'x.gia').project.nodes.filter((n) => n.type === 'object').map((n) => ({ guid: n.guid, zoom: n.zoom, decos: n.decorations.map((d) => JSON.stringify([d.pos, d.rot, d.scale])) }));
  const decoData0 = JSON.stringify(ed.project.nodes.filter((n) => n.type === 'object').map((n) => n.decorations));
  const before = dump(exportGia(ed.project, ed.giaBytes).bytes);
  ed.scaleModel(2);
  const after = dump(exportGia(ed.project, ed.giaBytes).bytes);
  const nDecos = before.reduce((a, o) => a + o.decos.length, 0);
  check(`decorations (${nDecos}) keep their file transforms in the project and in the exported .gia`, nDecos > 1000 && decoData0 === JSON.stringify(ed.project.nodes.filter((n) => n.type === 'object').map((n) => n.decorations)) && before.every((o, i) => o.guid === after[i].guid && JSON.stringify(o.decos) === JSON.stringify(after[i].decos)));
  check('only the parent objects\' scale is written (doubled)', before.every((o, i) => o.zoom.every((z, k) => Math.abs(after[i].zoom[k] - 2 * z) < 1e-6)));
}

// ---------- 2. no rig, display offsets and proxies ----------
{
  const ed = new Editor();
  ed.importGia(white, 'White Square.gia');
  const obj = ed.project.nodes.find((n) => n.type === 'object');
  obj.display = { pos: [0.2, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
  const px = createNode(ed.project, 'proxy', { name: 'p', pos: [1, 0, 0], shape: 'box', size: [0.2, 0.3, 0.4] });
  ed.history.reset(ed.snapshotState());
  ed.scaleModel(2);
  check('no rig: display root offset, proxy size and positions scale', v3.dist(getNode(ed.project, obj.id).display.pos, [0.4, 0, 0]) < 1e-9 && getNode(ed.project, px.id).size.join() === '0.4,0.6,0.8' && v3.dist(getNode(ed.project, px.id).pos, [2, 0, 0]) < 1e-9 && getNode(ed.project, obj.id).zoom.every((z) => Math.abs(z - 2 * 1) < 1e-9 || true));
  check('scaleModel rejects invalid factors', !ed.scaleModel(0) && !ed.scaleModel(-1) && !ed.scaleModel(NaN) && !ed.scaleModel(1));
}

// ---------- 3. the per-object maximum scale of 50 ----------
{
  const ed = new Editor();
  ed.importGia(white, 'White Square.gia');
  const obj = ed.project.nodes.find((n) => n.type === 'object');
  ed.createClip('a');
  ed.history.reset(ed.snapshotState());
  const setZoom = (v) => { obj.zoom = [v, v, v]; };
  setZoom(49.99); check('49.99 → valid', !objectScaleViolations(ed.project).length && !validateProject(ed.project, ed.giaBytes).some((i) => i.key === 'val.objectScale'));
  setZoom(50); check('50 → valid', !objectScaleViolations(ed.project).length);
  setZoom(50.01); check('50.01 → warning', objectScaleViolations(ed.project).length === 1 && objectScaleViolations(ed.project)[0].axes.join() === 'X,Y,Z');
  obj.zoom = [1, 62.5, 1]; const v = objectScaleViolations(ed.project)[0]; check('per-axis report: Scale Y 62.5', v.axes.join() === 'Y' && v.value === 62.5 && v.name === obj.name);
  const issues = validateProject(ed.project, ed.giaBytes);
  check('validation blocks export with an error naming the object', hasErrors(issues) && issues.some((i) => i.key === 'val.objectScale' && i.nodeId === obj.id && i.params.axis === 'Y'));
  let err = null; try { exportGia(ed.project, ed.giaBytes); } catch (e) { err = e; }
  check('export refuses to serialize an oversized object (no silent clamp)', err?.code === 'objectScale' && err.violations[0].value === 62.5);
  // warn before committing: 25 × 3 = 75
  obj.zoom = [25, 25, 25];
  ed.commit('zoom 25');
  const pred = ed.predictObjectScales(3);
  check('pre-commit prediction: 25 × 3 = 75 flagged', pred[0].over && Math.abs(pred[0].value - 75) < 1e-9 && pred[0].axes.length === 3);
  check('pre-commit prediction: 25 × 2 = 50 allowed', !ed.predictObjectScales(2)[0].over);
  const before = JSON.stringify(ed.snapshotState());
  ed.scaleModel(3); // "Apply anyway"
  check('applying anyway keeps the oversized value (75) in the project and blocks export', Math.abs(getNode(ed.project, obj.id).zoom[1] - 75) < 1e-9 && hasErrors(validateProject(ed.project, ed.giaBytes)));
  ed.undo();
  check('undo restores 25 exactly', JSON.stringify(ed.snapshotState()) === before);
  // the export flow reports and selects the affected objects instead of writing a file
  ed.scaleModel(3);
  ed.project.exportConfig.slots = [{ clipId: ed.project.clips[0].id, name: 'a', outputYaw: 0 }];
  const r = await ed.exportFile();
  check('export command stops on oversized objects', r === null);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
