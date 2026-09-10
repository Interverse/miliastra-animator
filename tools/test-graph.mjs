// Graph Editor data layer: per-component curves over the ONE keyframe store, tangent handles,
// multi-turn rotation channels, editing through the editor (undo, copy/paste, simplify), IK
// control channels, imported/dense animation, save/reopen and export.
//   node tools/test-graph.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { activeClip, insertKey, evaluateKeys, evaluateRotation, keyRef } from '../js/anim/clips.js';
import { channelsOf, evaluateComponent, hermite, keySlopes, autoSlope, trackEuler, pointRef, simplifyKeys, setKeyHandleMode } from '../js/anim/curves.js';
import { xOf, yOf, timeAt, valueAt, fitView, niceStep, sampleChannel, hitPoint, pointsInBox } from '../js/ui/graph-geom.js';
import { quat } from '../js/core/math.js';
import { bakeClip } from '../js/anim/bake.js';
import { buildExportPlan, pathLimitViolations, compressPlan, MAX_PATH_POINTS } from '../js/gia/gia-export.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const fx = (path) => readFileSync(new URL('./fixtures/' + path, import.meta.url));

// ---------- 1. eased segments: Hermite with flat handles == the old smoothstep ----------
{
  const keys = [{ t: 0, v: [0, 0, 0], i: 'ease' }, { t: 1, v: [2, 4, -6], i: 'ease' }];
  let ok = true;
  for (let u = 0; u <= 1.0001; u += 0.05) {
    const s = u * u * (3 - 2 * u);
    const v = evaluateKeys(keys, u, 'pos');
    for (let c = 0; c < 3; c++) if (!near(v[c], keys[1].v[c] * s, 1e-9)) ok = false;
  }
  check('ease with default (flat) handles is exactly the previous smoothstep', ok);
  check('hermite basis: flat ends reproduce smoothstep at u=0.25', near(hermite(0, 0, 1, 0, 1, 0.25), 0.25 * 0.25 * (3 - 0.5)));
  check('hermite: unit slope at both ends over dt=2 gives a straight line', near(hermite(0, 1, 2, 1, 2, 0.3), 0.6));
}

// ---------- 2. tangent modes ----------
{
  const keys = [{ t: 0, v: [0, 0, 0], i: 'ease' }, { t: 1, v: [1, 0, 0], i: 'ease' }, { t: 2, v: [3, 0, 0], i: 'ease' }, { t: 3, v: [2, 0, 0], i: 'ease' }];
  const s1 = autoSlope(keys, 1, 'pos', 0);
  check('auto tangent at a monotonic interior key follows the neighbours', s1 > 0 && s1 <= 3 * Math.min(1, 2), String(s1));
  check('auto tangent is flat at an extremum (no overshoot)', autoSlope(keys, 2, 'pos', 0) === 0);
  check('auto tangent is flat at the ends', autoSlope(keys, 0, 'pos', 0) === 0 && autoSlope(keys, 3, 'pos', 0) === 0);
  setKeyHandleMode(keys, 1, 'pos', 'auto');
  const sl = keySlopes(keys, 1, 'pos', 0);
  check("setKeyHandleMode('auto') is applied at evaluation", sl.in === s1 && sl.out === s1);
  setKeyHandleMode(keys, 1, 'pos', 'aligned');
  check("switching to 'aligned' freezes the current slopes (no jump)", keys[1].h.m === 'aligned' && near(keys[1].h.in[0], s1) && near(keys[1].h.out[0], s1));
  keys[1].h = { m: 'free', in: [0, 0, 0], out: [5, 0, 0] };
  const v = evaluateComponent(keys, 1.25, 'pos', 0);
  check('free handles: a steep out-slope pulls the curve up right after the key', v > 1 + 0.25 * 2 * 0.5, String(v));
  const lin = [{ t: 0, v: [0, 0, 0], i: 'linear' }, { t: 1, v: [1, 0, 0], i: 'linear' }];
  check('linear: constant rate', near(evaluateComponent(lin, 0.3, 'pos', 0), 0.3));
  const st = [{ t: 0, v: [0, 0, 0], i: 'step' }, { t: 1, v: [1, 0, 0], i: 'step' }];
  check('stepped: holds the previous value', evaluateComponent(st, 0.99, 'pos', 0) === 0 && evaluateComponent(st, 1, 'pos', 0) === 1);
}

// ---------- 3. rotation channels keep multi-turn values ----------
{
  for (const target of [450, 720, 1080, -720]) {
    const keys = [{ t: 0, v: quat.fromEulerDeg([0, 0, 0]), i: 'linear', e: [0, 0, 0] }, { t: 2, v: quat.fromEulerDeg([0, target, 0]), i: 'linear', e: [0, target, 0] }];
    const mid = evaluateComponent(keys, 1, 'rot', 1);
    const samples = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((t) => evaluateComponent(keys, t, 'rot', 1));
    const monotone = samples.every((v, i) => i === 0 || (target > 0 ? v >= samples[i - 1] : v <= samples[i - 1]));
    check(`rotation curve 0 → ${target}°: midpoint ${target / 2}, never wrapped`, near(mid, target / 2) && monotone && near(samples[8], target));
    const q = evaluateRotation(keys, 1.5).q;
    check(`rotation curve 0 → ${target}°: evaluated quaternion matches the authored angle`, quat.angle(q, quat.fromEulerDeg([0, target * 0.75, 0])) < 1e-6);
  }
  // eased multi-turn: still passes through the authored turns, with Hermite timing
  const keys = [{ t: 0, v: quat.fromEulerDeg([0, 0, 0]), i: 'ease', e: [0, 0, 0] }, { t: 2, v: quat.fromEulerDeg([0, 720, 0]), i: 'ease', e: [0, 720, 0] }];
  check('eased 0 → 720°: half-way value is 360 and the curve is monotone', near(evaluateComponent(keys, 1, 'rot', 1), 360) && evaluateComponent(keys, 0.5, 'rot', 1) < 360 && evaluateComponent(keys, 1.5, 'rot', 1) > 360);
  // quaternion-only keys (imported): the Euler chain is continuous, never a shortest-arc jump
  const qk = [0, 100, 200, 300, 400].map((deg, i) => ({ t: i * 0.5, v: quat.fromEulerDeg([0, deg, 0]), i: 'linear' }));
  const es = trackEuler(qk);
  check('quaternion-only keys get a continuous Euler chain (100° steps rise to 400)', es.every((e, i) => near(e[1], i * 100, 1e-6)), JSON.stringify(es.map((e) => Math.round(e[1]))));
}

// ---------- 4. channels: position, rotation, IK targets and poles ----------
const ed = new Editor();
ed.openProjectFile(readFileSync(new URL('./fixtures/bangboo-hips.animator.json', import.meta.url), 'utf8'));
{
  const clip = activeClip(ed.project);
  const groups = channelsOf(clip, { nodeById: (id) => ed.project.nodes.find((n) => n.id === id) });
  const types = new Set(groups.map((g) => g.node?.type));
  check('the user rig lists channels for bones and IK targets', groups.length > 0 && types.has('bone') && types.has('target'), [...types].join(','));
  const target = groups.find((g) => g.node?.type === 'target');
  check('IK target exposes position X/Y/Z channels', target && target.channels.filter((c) => c.ch === 'pos').length === 3);
  const chs = groups.flatMap((g) => g.channels);
  check('channels use consistent X/Y/Z axes and units', chs.every((c) => ['X', 'Y', 'Z'].includes(c.axis) && (c.unit === 'm' || c.unit === 'deg')));
  // IK target curve drives the evaluated rig: move the target's key and the chain bone moves
  const tr = clip.tracks[target.nodeId];
  const k0 = tr.pos[0];
  const constraint = ed.project.constraints.find((k) => k.targetId === target.nodeId);
  const before = ed.pose().world.get(constraint.boneId).rot.slice();
  ed.setTime(k0.t);
  ed.selectCurvePoints([pointRef(target.nodeId, 'pos', k0.t, 1)]);
  ed.moveCurvePoints({ dv: 0.3, unit: 'm' });
  const after = ed.pose().world.get(constraint.boneId).rot;
  check('editing an IK target curve re-solves the chain (bone rotation changes)', quat.angle(before, after) > 1e-3);
  ed.undo();
  check('undo restores the IK-driven pose exactly', quat.angle(before, ed.pose().world.get(constraint.boneId).rot) < 1e-9);
  const driven = groups.find((g) => g.node?.type === 'bone' && ed.constraintDriving(g.nodeId));
  check('constraint-driven bones are identifiable for the channel list', !!driven);
}

// ---------- 5. editing through the editor: one data model, undo/redo, copy/paste ----------
ed.newProject();
ed.importGia(new Uint8Array(fx('White Square.gia')), 'White Square.gia');
const obj = ed.project.nodes.find((n) => n.type === 'object');
ed.createClip();
const clip = activeClip(ed.project);
const K = (tm, p, e) => insertKey(clip, obj.id, 'pos', tm, p, 'ease');
K(0, [0, 0, 0]); K(1, [1, 0.5, 0]); K(2, [0, 1, 0]);
insertKey(clip, obj.id, 'rot', 0, quat.fromEulerDeg([0, 0, 0]), 'linear', [0, 0, 0]);
insertKey(clip, obj.id, 'rot', 2, quat.fromEulerDeg([0, 720, 0]), 'linear', [0, 720, 0]);
ed.commit('setup');
{
  const snap = JSON.stringify(ed.project.clips);
  ed.selectCurvePoints([pointRef(obj.id, 'pos', 1, 1)]);          // Position Y at t=1
  ed.moveCurvePoints({ dt: 0.25, dv: 0.2, unit: 'm' }, false);     // drag (transient)
  ed.moveCurvePoints({ dv: 0.1, unit: 'm' }, true);                 // release (one commit)
  const k = clip.tracks[obj.id].pos.find((x) => near(x.t, 1.25));
  check('dragging a point moves the key in time and value (other components untouched)', k && near(k.v[1], 0.8) && near(k.v[0], 1) && near(k.v[2], 0));
  check('the Dope Sheet sees the same moved key (shared selection)', ed.selectedKeys.has(keyRef(obj.id, 'pos', 1.25)));
  const entries = ed.history.undoStack.length;
  ed.undo();
  check('one continuous drag is one undo step and restores exact data', JSON.stringify(ed.project.clips) === snap, `stack ${entries}`);
  ed.redo();
  check('redo re-applies the drag', near(activeClip(ed.project).tracks[obj.id].pos.find((x) => near(x.t, 1.25)).v[1], 0.8));
  // value units never mix: a degree delta does not touch position keys
  ed.selectCurvePoints([pointRef(obj.id, 'pos', 0, 0), pointRef(obj.id, 'rot', 0, 1)]);
  ed.moveCurvePoints({ dv: 90, unit: 'deg' });
  const c2 = activeClip(ed.project);
  check('a rotation drag changes only degree channels', near(c2.tracks[obj.id].pos[0].v[0], 0) && near(c2.tracks[obj.id].rot[0].e[1], 90));
  ed.undo();
  // numeric editing
  ed.setPointValue(pointRef(obj.id, 'rot', 2, 1), 1080);
  check('numeric value edit of a rotation point keeps the authored turns (1080°)', near(activeClip(ed.project).tracks[obj.id].rot[1].e[1], 1080) && near(evaluateComponent(activeClip(ed.project).tracks[obj.id].rot, 1, 'rot', 1), 540));
  ed.setPointTime(pointRef(obj.id, 'rot', 2, 1), 1.5);
  check('numeric time edit moves the key (and respects the frame grid)', !!activeClip(ed.project).tracks[obj.id].rot.find((x) => near(x.t, 1.5)));
  ed.undo(); ed.undo();
  // tangents
  ed.setPointTangent(pointRef(obj.id, 'pos', 1.25, 1), 'out', 2);
  const kk = activeClip(ed.project).tracks[obj.id].pos.find((x) => near(x.t, 1.25));
  check('editing a handle stores an aligned tangent and shapes the curve', kk.h?.m === 'aligned' && near(kk.h.out[1], 2) && near(kk.h.in[1], 2) && evaluateComponent(activeClip(ed.project).tracks[obj.id].pos, 1.4, 'pos', 1) > 0.8);
  ed.selectCurvePoints([pointRef(obj.id, 'pos', 1.25, 1)]);
  ed.setKeyHandles('free'); ed.setPointTangent(pointRef(obj.id, 'pos', 1.25, 1), 'in', -1, { free: true });
  const kf = activeClip(ed.project).tracks[obj.id].pos.find((x) => near(x.t, 1.25));
  check('free handles: in and out slopes differ', kf.h.m === 'free' && near(kf.h.in[1], -1) && near(kf.h.out[1], 2));
  ed.flattenTangents();
  check('flatten handles', activeClip(ed.project).tracks[obj.id].pos.find((x) => near(x.t, 1.25)).h.m === 'flat');
  ed.undo(); ed.undo(); ed.undo(); ed.undo();
  check('undo restores tangent data exactly', JSON.stringify(activeClip(ed.project).tracks[obj.id].pos.find((x) => near(x.t, 1.25)).h || null) === 'null');
  // copy / paste carries handles and unwrapped angles
  ed.selectCurvePoints([pointRef(obj.id, 'pos', 1.25, 0)]);
  ed.setPointTangent(pointRef(obj.id, 'pos', 1.25, 0), 'out', 3);
  ed.selectKeys([keyRef(obj.id, 'pos', 1.25), keyRef(obj.id, 'rot', 2)]);
  ed.copySelectedKeys();
  ed.setTime(3);
  ed.pasteKeys();
  const c3 = activeClip(ed.project);
  const pasted = c3.tracks[obj.id].pos.find((x) => near(x.t, 3));
  const pastedRot = c3.tracks[obj.id].rot.find((x) => near(x.t, 3.75));
  check('copy/paste keeps tangents and multi-turn angles', pasted?.h?.m === 'aligned' && near(pasted.h.out[0], 3) && pastedRot && near(pastedRot.e[1], 720));
  ed.undo(); ed.undo();
}

// ---------- 5b. drag transaction: total offsets from the start, merges are transient, one undo ----------
{
  const keysAt = () => activeClip(ed.project).tracks[obj.id].pos.map((k) => +k.t.toFixed(3));
  const c = { get tracks() { return activeClip(ed.project).tracks; } }; // always the live clip (undo swaps the project)
  const startKeys = keysAt();                                   // [0, 1.25, 2] after the earlier edits
  const undo0 = ed.history.undoStack.length;
  ed.selectCurvePoints([pointRef(obj.id, 'pos', 0, 0)]);
  check('a drag transaction starts from the selection', ed.beginKeyDrag());
  ed.updateKeyDrag({ dt: 0.5 });                                // frame by frame: total offsets, not deltas
  ed.updateKeyDrag({ dt: 1.25 });                               // lands exactly on the 1.25 key: merges while passing
  check('passing over another key merges it only for the moment', keysAt().length === startKeys.length - 1);
  ed.updateKeyDrag({ dt: 1.5 });                                // and it reappears when the pointer moves on
  check('moving on restores the key that was passed over (snapshot re-applied each move)', keysAt().length === startKeys.length && keysAt().includes(1.25) && keysAt().includes(1.5));
  ed.updateKeyDrag({ dt: 0.75, dv: 0.3, unit: 'm' });
  check('time and value are measured from the drag start (0.75 s, +0.3 m), not accumulated', keysAt().includes(0.75) && near(c.tracks[obj.id].pos.find((k) => near(k.t, 0.75)).v[0], 0.3));
  check('no history entries are created while dragging', ed.history.undoStack.length === undo0);
  ed.endKeyDrag(true);
  check('release commits exactly one entry', ed.history.undoStack.length === undo0 + 1 && keysAt().includes(0.75));
  ed.undo();
  check('undo restores the pre-drag keys exactly', JSON.stringify(keysAt()) === JSON.stringify(startKeys));
  ed.selectCurvePoints([pointRef(obj.id, 'pos', 0, 1)]);
  ed.beginKeyDrag(); ed.updateKeyDrag({ dt: 0.4, dv: 1, unit: 'm' }); ed.endKeyDrag(false);
  check('cancel (Escape / pointercancel) puts the snapshot back with no history entry', JSON.stringify(keysAt()) === JSON.stringify(startKeys) && near(c.tracks[obj.id].pos[0].v[1], 0) && ed.history.undoStack.length === undo0);
  // multi-key drag keeps relative spacing across a merge point
  ed.selectKeys([keyRef(obj.id, 'pos', 0), keyRef(obj.id, 'pos', 1.25)]);
  ed.beginKeyDrag(); ed.updateKeyDrag({ dt: 0.75 });
  check('multiple selected keys keep their spacing (0 to 0.75, 1.25 to 2 merges with the last key transiently)', keysAt().includes(0.75) && keysAt().includes(2));
  ed.updateKeyDrag({ dt: 0.3 });
  check('and separate again on the way back', JSON.stringify(keysAt()) === JSON.stringify([0.3, 1.55, 2]));
  ed.endKeyDrag(false);
  check('cancelled multi-key drag restores everything', JSON.stringify(keysAt()) === JSON.stringify(startKeys));
}

// ---------- 5c. scrubbing from the Graph Editor / Dope Sheet is not ended by its own time changes ----------
{
  for (const kind of ['graph-scrub', 'timeline-scrub', 'graph-move']) {
    let finished = 0;
    ed.beginInteraction(kind, { finish: () => finished++, cancel: () => finished++ });
    ed.setTime(0.2); ed.setTime(0.4); ed.setTime(0.6);
    check(`${kind}: moving the playhead keeps the interaction alive`, ed.interaction?.kind === kind && finished === 0);
    ed.finishInteraction();
  }
  let finished = 0;
  ed.beginInteraction('gizmo-move', { finish: () => finished++, cancel: () => finished++ });
  ed.setTime(0.8);
  check('a viewport transform is still finished when the frame changes', finished === 1 && !ed.interaction);
}

// ---------- 6. Auto Key / inspector edits show up as curve points ----------
{
  ed.project.settings.autoKey = true;
  ed.setTime(0.5);
  ed.select(obj.id);
  ed.setNodeLocal(obj.id, { pos: [0.4, 0.4, 0.4] });
  const k = activeClip(ed.project).tracks[obj.id].pos.find((x) => near(x.t, 0.5));
  check('Auto Key: a viewport/inspector edit creates the key the graph shows', k && near(k.v[0], 0.4));
  ed.project.settings.autoKey = false;
  ed.setNodeLocal(obj.id, { pos: [0.9, 0.4, 0.4] });
  check('inspector edit at a keyed frame updates the same key (no separate graph data)', near(activeClip(ed.project).tracks[obj.id].pos.find((x) => near(x.t, 0.5)).v[0], 0.9));
  check('graph channels reflect the canonical tracks', channelsOf(activeClip(ed.project)).flatMap((g) => g.channels).length === 6);
}

// ---------- 7. box selection / view geometry (pure) ----------
{
  const view = fitView({ left: 0, top: 0, w: 400, h: 200 }, { t0: 0, t1: 2, v0: -1, v1: 1 });
  check('fitView maps the range inside the plot', xOf(view, 0) > 0 && xOf(view, 2) < 400 && yOf(view, 1) > 0 && yOf(view, -1) < 200);
  check('view mapping round-trips', near(timeAt(view, xOf(view, 1.234)), 1.234, 1e-9) && near(valueAt(view, yOf(view, -0.5)), -0.5, 1e-9));
  check('nice tick steps are 1/2/5 × 10^n', [niceStep(100), niceStep(7), niceStep(0.5)].every((s) => [1, 2, 5].includes(Number((s / Math.pow(10, Math.floor(Math.log10(s)))).toFixed(6)))));
  const pts = [{ x: 10, y: 10, id: 'a' }, { x: 50, y: 50, id: 'b' }, { x: 90, y: 90, id: 'c' }];
  check('hit test picks the nearest point within radius', hitPoint(pts, 52, 49).id === 'b' && hitPoint(pts, 70, 70) === null);
  check('box selection selects exactly the enclosed points', pointsInBox(pts, 0, 0, 60, 60).map((p) => p.id).join() === 'a,b');
  const keys = [{ t: 0, v: [0, 0, 0], i: 'ease' }, { t: 1, v: [1, 0, 0], i: 'ease' }, { t: 2, v: [0, 0, 0], i: 'step' }, { t: 3, v: [1, 0, 0], i: 'linear' }];
  const s = sampleChannel(keys, 'pos', 0, null, -0.5, 3.5, 200);
  check('sampling: keys are samples, eased segments are subdivided, steps hold', s.filter((p) => p.key !== null).length === 4 && s.length > 12 && s.some((p) => near(p.t, 3) && p.v === 0));
}

// ---------- 8. simplification preserves shape, turns, pauses and steps ----------
{
  // dense straight line: collapses to 2 keys
  const dense = Array.from({ length: 41 }, (_, i) => ({ t: i * 0.05, v: [i * 0.05, 0, 0], i: 'linear' }));
  const r1 = simplifyKeys(dense, 'pos', 0.001);
  check('dense linear samples simplify to the end points', r1.keys.length === 2 && r1.removed === 39);
  // a pause (plateau) keeps its boundary keys
  const pause = [{ t: 0, v: [0, 0, 0], i: 'linear' }, { t: 1, v: [1, 0, 0], i: 'linear' }, { t: 2, v: [1, 0, 0], i: 'linear' }, { t: 3, v: [2, 0, 0], i: 'linear' }];
  check('a plateau is kept', simplifyKeys(pause, 'pos', 0.01).keys.length === 4);
  // stepped keys are never merged away
  const stepped = [{ t: 0, v: [0, 0, 0], i: 'step' }, { t: 1, v: [0.001, 0, 0], i: 'step' }, { t: 2, v: [0, 0, 0], i: 'step' }];
  check('stepped keys are kept even when tiny', simplifyKeys(stepped, 'pos', 0.1).keys.length === 3);
  // a spin sampled every 45°: simplifying must keep the turn count (dense quaternion-only keys)
  const spin = Array.from({ length: 17 }, (_, i) => ({ t: i * 0.1, v: quat.fromEulerDeg([0, i * 45, 0]), i: 'linear' }));
  const es = trackEuler(spin);
  const r2 = simplifyKeys(spin, 'rot', 0.5, es);
  const kept = r2.keys;
  const eKept = kept.map((k) => es[spin.indexOf(k)]);
  check('a 720° spin simplifies to 2 keys and still spans 720° (turn count preserved)', kept.length === 2 && near(eKept[1][1] - eKept[0][1], 720), `${kept.length} keys, ${eKept[eKept.length - 1][1]}°`);
  // direction reversal inside the spin survives
  const back = [...Array.from({ length: 9 }, (_, i) => ({ t: i * 0.1, v: quat.fromEulerDeg([0, i * 45, 0]), i: 'linear' })), ...Array.from({ length: 8 }, (_, i) => ({ t: 0.9 + i * 0.1, v: quat.fromEulerDeg([0, 360 - (i + 1) * 45, 0]), i: 'linear' }))];
  const es2 = trackEuler(back);
  const r3 = simplifyKeys(back, 'rot', 0.5, es2);
  const peak = r3.keys.find((k) => near(es2[back.indexOf(k)][1], 360));
  check('a reversal (0 → 360 → 45) keeps its turning point', r3.keys.length === 3 && !!peak);
  // through the editor: undoable
  ed.newProject();
  ed.importGia(new Uint8Array(fx('White Square.gia')), 'White Square.gia');
  const o = ed.project.nodes.find((n) => n.type === 'object');
  ed.createClip();
  const c = activeClip(ed.project);
  for (let i = 0; i <= 40; i++) insertKey(c, o.id, 'pos', i * 0.05, [Math.sin(i * 0.05 * Math.PI) , 0, 0], 'linear');
  ed.commit('dense');
  const dry = ed.simplifyCurves({ tolPos: 0.01 }, { dryRun: true });
  const res = ed.simplifyCurves({ tolPos: 0.01 });
  check('Simplify curves: preview equals the result, keys are reduced, shape kept within tolerance', dry.after === res.after && res.after < res.before && res.after >= 5, `${res.before} → ${res.after}`);
  const c2 = activeClip(ed.project);
  let maxErr = 0;
  for (let i = 0; i <= 40; i++) maxErr = Math.max(maxErr, Math.abs(evaluateComponent(c2.tracks[o.id].pos, i * 0.05, 'pos', 0) - Math.sin(i * 0.05 * Math.PI)));
  check('simplified curve stays within tolerance of the original', maxErr <= 0.0100001, maxErr.toFixed(4));
  ed.undo();
  check('simplify is undoable', activeClip(ed.project).tracks[o.id].pos.length === 41);
}

// ---------- 9. imported (retargeted) animation and save / reopen ----------
{
  const ed2 = new Editor();
  ed2.openProjectFile(readFileSync(new URL('./fixtures/bangboo-hips.animator.json', import.meta.url), 'utf8'));
  const c = activeClip(ed2.project);
  const total = Object.values(c.tracks).reduce((a, tr) => a + tr.pos.length + tr.rot.length, 0);
  const groups = channelsOf(c);
  check('imported/retargeted clips expose every keyed channel', total > 0 && groups.length > 0, `${total} keys, ${groups.length} nodes`);
  // give one key a tangent and a multi-turn angle, save, reopen
  const [nodeId] = Object.keys(c.tracks).filter((id) => c.tracks[id].rot.length);
  ed2.ensureEulerTrack(nodeId);
  const rk = c.tracks[nodeId].rot[0];
  const e0 = rk.e[0];
  ed2.selectCurvePoints([pointRef(nodeId, 'rot', rk.t, 0)]);
  ed2.setKeyHandles('aligned');
  ed2.setPointTangent(pointRef(nodeId, 'rot', rk.t, 0), 'out', 45);
  ed2.setPointValue(pointRef(nodeId, 'rot', rk.t, 0), rk.e[0] + 720);
  const json = ed2.projectFileJSON();
  const ed3 = new Editor();
  ed3.openProjectFile(json);
  const rk2 = activeClip(ed3.project).tracks[nodeId].rot[0];
  check('save/reopen keeps handles, handle mode and unwrapped angles', rk2.h?.m === 'aligned' && near(rk2.h.out[0], 45) && near(rk2.e[0], e0 + 720), `${rk2.e[0]} vs ${e0 + 720}`);
  const rec = ed2.projectRecord();
  ed2.setGraphUI({ normalize: true, active: 'x|pos|0' });
  const rec2 = ed2.projectRecord();
  const ed4 = new Editor(); ed4.applyRecord(rec2);
  check('Graph UI state (normalize, active channel) is saved with the project record', ed4.graphUI.normalize === true && ed4.graphUI.active === 'x|pos|0' && rec.ui.graph.normalize === false);
}

// ---------- 10. export: curves → Motion Devices, path limit still enforced ----------
{
  const ed5 = new Editor();
  ed5.importGia(new Uint8Array(fx('White Square.gia')), 'White Square.gia');
  const o = ed5.project.nodes.find((n) => n.type === 'object');
  ed5.createClip();
  const c = activeClip(ed5.project);
  const p0 = o.pos.slice();
  insertKey(c, o.id, 'pos', 0, p0, 'linear');
  insertKey(c, o.id, 'pos', 2, [p0[0] + 4, p0[1], p0[2]], 'linear');
  ed5.commit('lin');
  const lin = bakeClip(ed5.project, c).points.get(o.id);
  check('a truly linear A→B segment stays ONE movement (no per-frame sampling)', lin.moves && lin.points.length === 1, `${lin.points.length} points`);
  insertKey(c, o.id, 'pos', 0, p0, 'ease');
  c.tracks[o.id].pos[0].h = { m: 'aligned', in: [0, 0, 0], out: [6, 0, 0] };
  ed5.commit('ease');
  const eased = bakeClip(ed5.project, c).points.get(o.id);
  check('an eased segment is baked into several linear pieces', eased.points.length > 2 && eased.points.length < 60, `${eased.points.length} points`);
  insertKey(c, o.id, 'rot', 0, quat.fromEulerDeg([0, 0, 0]), 'ease', [0, 0, 0]);
  insertKey(c, o.id, 'rot', 2, quat.fromEulerDeg([0, 720, 0]), 'ease', [0, 720, 0]);
  ed5.commit('spin');
  const spun = bakeClip(ed5.project, c).points.get(o.id);
  let turned = 0, prev = quat.fromEulerDeg([0, 0, 0]);
  for (const p of spun.points) { turned += quat.angle(prev, p.rot) * 180 / Math.PI; prev = p.rot; }
  check('two full eased turns survive baking (accumulated rotation ≈ 720°)', Math.abs(turned - 720) < 5, turned.toFixed(1));
  const plan = buildExportPlan(ed5.project, ed5.giaBytes);
  const over = pathLimitViolations(plan);
  const plan2 = over.length ? compressPlan(plan) : plan;
  check('path limit: the plan is within 49 points (compressing when needed)', pathLimitViolations(plan2).length === 0 && plan2.devices.every((d) => d.points.length <= MAX_PATH_POINTS));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall graph checks passed');
process.exit(failures ? 1 : 0);
