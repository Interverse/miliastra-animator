// Editor project + original .gia bytes → animated .gia.
//
// Only what animation needs is touched: object names/transforms that the user
// edited, the Basic Motion Device component of participating objects, the
// static → dynamic conversion, and one new controller object + node graph.
// Everything else in the file passes through untouched.
import {
  parseGia, serializeGia, collectObjects, setObjectName, setObjectTransform, makeDynamic, setMotionDevices,
  insertEntry, removeEntry, lastEntryOfKind, allGuids, readObject,
} from './gia-file.js';
import { motionDeviceFields, MOTION_ONE_WAY, MOTION_CYCLIC, MAX_DEVICES_PER_OBJECT, MIN_POINT_DURATION } from './motion-device.js';
import { buildControllerEntry, buildGraphEntry, CONTROLLER_NAME, GRAPH_NAME } from './node-graph.js';
import { nextObjectGuid, nextGraphGuid } from './guids.js';
import { bakeClip, PRECISION } from '../anim/bake.js';
import { restWorld, evaluatePose } from '../anim/evaluate.js';
import { getClip } from '../anim/clips.js';
import { v3, quat, displayToGamePos, displayQuatToGameEuler, gameEulerToDisplayQuat } from '../core/math.js';
import { compressPath, MAX_PATH_POINTS, GAME_PATH_POINTS, ACCEPTABLE_ERROR } from '../anim/path-compress.js';
export { MAX_PATH_POINTS, GAME_PATH_POINTS };
// Miliastra's maximum scale per object (any axis). Never clamped silently: the editor warns
// when a whole-model scale would exceed it and the export refuses to serialize such objects.
export const MAX_OBJECT_SCALE = 50;
export function objectScaleViolations(project, max = MAX_OBJECT_SCALE) {
  const out = [];
  for (const n of project.nodes) {
    if (n.type !== 'object') continue;
    const z = n.zoom || [1, 1, 1];
    const axes = ['X', 'Y', 'Z'].filter((_, i) => Math.abs(z[i]) > max + 1e-9);
    if (axes.length) out.push({ nodeId: n.id, guid: n.guid, name: n.name, zoom: z.slice(), axes, value: Math.max(...z.map(Math.abs)), max });
  }
  return out;
}

// ---------- Output rotation ----------
// A slot's output rotation is a rigid transform of the COMPLETE assembled model:
// every exported object's world pose is rotated about the shared export pivot
// (the model origin = configured global position offset) exactly as if the
// whole model sat under one temporary root that was turned by that angle.
// It is applied to the evaluated world pose (parents, bones, corrections and
// animation already composed) in display space, so the preview and the file
// agree, and only then converted to the Motion Device representation:
// position relative to the object's placement, rotation absolute.
export function exportPivot(project) { return v3.clone(project.settings?.globalOffset || [0, 0, 0]); }
// display-space quaternion of a game yaw (degrees about the vertical axis)
export function outputRotation(yawDeg) { return yawDeg ? gameEulerToDisplayQuat({ x: 0, y: yawDeg, z: 0 }) : [0, 0, 0, 1]; }
export function rotateAboutPivot(w, R, pivot) {
  return { pos: v3.add(pivot, quat.rotate(R, v3.sub(w.pos, pivot))), rot: quat.norm(quat.mul(R, w.rot)) };
}

// Convert one world pose to a device waypoint: apply the slot's output rotation
// about the pivot, then position relative to the placement (world axes, or the
// placement's own axes) and absolute rotation, both in game space.
// `refEuler` (display-space YXZ degrees of the previous point / the placement) keeps the
// written Euler values continuous along a path: the representation nearest the previous
// point is chosen, so a turn through X = 90° never serializes as a ±180° jump on Y and Z
// (game space is the same YXZ triple with Y and Z negated, so continuity carries over).
export function toWaypoint(point, placement, yawDeg, frame, pivot = [0, 0, 0], refEuler = null) {
  const w = yawDeg ? rotateAboutPivot(point, outputRotation(yawDeg), pivot) : point;
  let delta = v3.sub(w.pos, placement.pos);
  if (frame === 'local') delta = quat.rotate(quat.conj(placement.rot), delta);
  const dg = displayToGamePos(delta);
  const eD = refEuler ? quat.eulerNear(w.rot, refEuler) : quat.toEulerDeg(w.rot);
  const rotE = { x: eD[0], y: -eD[1], z: -eD[2] };
  const clean = (v) => (Math.abs(v) < 1e-7 ? 0 : v);
  return {
    pos: { x: clean(dg.x), y: clean(dg.y), z: clean(dg.z) },
    rot: { x: clean(rotE.x), y: clean(rotE.y), z: clean(rotE.z) },
    duration: Math.max(MIN_POINT_DURATION, point.duration),
    eDisplay: eD,
  };
}
const yawOf = (slot) => { const y = ((slot.outputYaw || 0) % 360 + 360) % 360; return y < 1e-9 ? 0 : slot.outputYaw; };

export function exportSlots(project) {
  return (project.exportConfig.slots || []).filter((s) => getClip(project, s.clipId)).slice(0, MAX_DEVICES_PER_OBJECT);
}
export function initialSlotIndex(project) {
  const n = exportSlots(project).length;
  return n ? Math.min(Math.max(0, project.exportConfig.initialSlot | 0), n - 1) : -1;
}

// The placement written into the .gia for every object is the pose the editor
// shows at frame 0 of the initial animation (keys, parents, IK — everything the
// viewport shows), NOT the rig's rest pose: that is what the game shows before
// any animation runs, the initial animation starts from it without a snap, and
// every waypoint's relative position is measured from it. The rest pose only
// serves as placement when nothing is exported. (A rig whose rest rotation
// drifted away from its frame-0 key used to leak into the file as an extra
// rotation the editor never displayed.)
export function exportBasePose(project) {
  const i = initialSlotIndex(project);
  if (i < 0) return restWorld(project);
  const clip = getClip(project, exportSlots(project)[i].clipId);
  return evaluatePose(project, clip.id, 0).world;
}
// Output rotation of the reference (initial) animation — the one the exported
// graph plays first, which by default is the first slot in export order.
export function referenceYaw(project) {
  const i = initialSlotIndex(project);
  return i < 0 ? 0 : yawOf(exportSlots(project)[i]);
}
// The placement actually written to the file: the frame-0 pose turned by the
// reference animation's output rotation about the export pivot (whole-model
// transform, same as the waypoints). The model then RESTS in the orientation
// the first animation starts from, so "finish → return to rest → start again"
// is continuous instead of snapping from an unrotated rest pose.
export function exportPlacement(project) {
  const base = exportBasePose(project);
  const yaw = referenceYaw(project);
  if (!yaw) return base;
  const R = outputRotation(yaw), pivot = exportPivot(project);
  const out = new Map();
  for (const [id, w] of base) out.set(id, rotateAboutPivot(w, R, pivot));
  return out;
}

// Bake every export slot. Returns { slots: [{ slot, clip, baked }], warnings }
export function bakeAll(project) {
  const slots = exportSlots(project);
  const out = [];
  const warnings = [];
  const rest = exportBasePose(project);
  for (const slot of slots) {
    const clip = getClip(project, slot.clipId);
    const baked = bakeClip(project, clip, { precision: project.exportConfig.precision || 'normal', restPose: rest });
    for (const w of baked.warnings) warnings.push({ ...w, clipId: clip.id, slot });
    out.push({ slot, clip, baked });
  }
  return { slots: out, warnings, rest };
}

// ---------- Export plan ----------
// Everything that will be serialized, computed BEFORE any bytes are written:
// per participating object and export slot the final list of path points in
// display space (evaluated animation → baked segments → output rotation start
// snap → per-slot auto-compression). Validation (the 49-point safe limit) and
// export-time compression operate on this plan, so the counts always reflect
// the real number of points that reach the file. Building a plan never
// modifies the project.
export function buildExportPlan(project, giaBytes) {
  const doc = parseGia(giaBytes);
  const objects = collectObjects(doc);
  const entryByGuid = new Map(objects.map((o) => [o.guid, o.entry]));
  const rest = exportPlacement(project);
  const objectNodes = project.nodes.filter((n) => n.type === 'object' && n.guid != null && entryByGuid.has(n.guid));
  const { slots, warnings } = bakeAll(project);
  const pivot = exportPivot(project);
  const refYaw = referenceYaw(project);
  const anyRotated = slots.some((s) => yawOf(s.slot) !== refYaw);
  const participating = new Set();
  for (const s of slots) for (const node of objectNodes) if (anyRotated || s.baked.points.get(node.id)?.moves) participating.add(node.id);
  const tol = PRECISION[project.exportConfig.precision || 'normal'] || PRECISION.normal;
  const slotNames = slots.map((s) => s.slot.name || s.clip.name);
  const devices = [];
  for (const node of objectNodes) {
    if (!participating.has(node.id)) continue;
    slots.forEach((s, i) => {
      const b = s.baked.points.get(node.id);
      const restW = rest.get(node.id);
      const yaw = yawOf(s.slot);
      // this slot's (rotated) start pose vs. the resting placement: only a real
      // difference gets a 30 ms snap point, so the reference animation starts
      // exactly where the model rests
      const w0 = s.baked.frame0.get(node.id);
      const w0r = yaw ? rotateAboutPivot(w0, outputRotation(yaw), pivot) : w0;
      const startsOff = v3.dist(w0r.pos, restW.pos) > tol.pos * 0.5 || quat.angle(w0r.rot, restW.rot) > tol.rot * 0.5 * Math.PI / 180;
      let points = b && b.moves ? b.points.filter((p) => !p.snap).map((p) => ({ ...p })) : [];
      if (startsOff || !points.length) points.unshift({ t: 0, pos: w0.pos, rot: w0.rot, duration: MIN_POINT_DURATION, snap: true });
      const dev = { nodeId: node.id, guid: node.guid, objectName: node.name, slotIndex: i, slotName: slotNames[i], clipId: s.clip.id, clipName: s.clip.name, loop: !!s.clip.loop, yaw, points, rawCount: points.length, compression: null };
      // a slot the user chose to auto-compress (persisted, undoable project setting)
      if (s.slot.compress && points.length > MAX_PATH_POINTS) {
        const r = compressPath(points, { maxPoints: MAX_PATH_POINTS });
        dev.compression = { before: r.before, after: r.after, maxError: r.maxError, ok: r.ok, auto: true };
        if (r.ok) dev.points = r.points;
      }
      devices.push(dev);
    });
  }
  return { doc, objects, entryByGuid, rest, objectNodes, participating, slots, slotNames, warnings, devices, frame: project.settings.relativeFrame || 'world', pivot, scaleIssues: objectScaleViolations(project) };
}
// Devices whose final path exceeds the Miliastra limit.
export function pathLimitViolations(plan, max = MAX_PATH_POINTS) {
  return plan.devices.filter((d) => d.points.length > max).map((d) => ({ nodeId: d.nodeId, objectName: d.objectName, slotIndex: d.slotIndex, slotName: d.slotName, clipName: d.clipName, count: d.points.length, max }));
}
// Non-destructive: a copy of the plan in which every over-limit device (or the
// given ones) is compressed. Each result reports before/after counts, the
// largest deviation from the original motion and whether that is acceptable.
export function compressPlan(plan, { max = MAX_PATH_POINTS, acceptable = ACCEPTABLE_ERROR, only = null } = {}) {
  const results = [];
  const devices = plan.devices.map((d) => {
    const wanted = only ? only.some((o) => o.nodeId === d.nodeId && o.slotIndex === d.slotIndex) : d.points.length > max;
    if (!wanted) return d;
    const r = compressPath(d.points, { maxPoints: max, acceptable });
    const res = { nodeId: d.nodeId, objectName: d.objectName, slotIndex: d.slotIndex, slotName: d.slotName, clipName: d.clipName, before: r.before, after: r.after, maxError: r.maxError, reached: r.reached, ok: r.ok, max };
    results.push(res);
    return { ...d, points: r.points, compression: { ...res, auto: false } };
  });
  return { plan: { ...plan, devices }, results, ok: results.every((r) => r.ok) };
}

export function exportGia(project, giaBytes, { plan = null, enforceLimit = true } = {}) {
  plan = plan || buildExportPlan(project, giaBytes);
  // the limit is enforced at serialization time as well: an over-limit plan never reaches the file
  const over = pathLimitViolations(plan);
  if (enforceLimit && over.length) { const err = new Error(`path point limit exceeded: ${over.map((o) => `${o.objectName}/${o.slotName} ${o.count}`).join(', ')}`); err.code = 'pathLimit'; err.violations = over; throw err; }
  const oversized = plan.scaleIssues || objectScaleViolations(project);
  if (enforceLimit && oversized.length) { const err = new Error(`object scale exceeds ${MAX_OBJECT_SCALE}: ${oversized.map((o) => `${o.name} ${o.axes.join('/')} ${o.value.toFixed(2)}`).join(', ')}`); err.code = 'objectScale'; err.violations = oversized; throw err; }
  const { doc, objects, entryByGuid, rest, objectNodes, participating, slots, slotNames, frame, pivot } = plan;
  const report = { warnings: [], parts: [], slots: [], devices: 0, compressed: plan.devices.filter((d) => d.compression && d.points.length < d.rawCount).map((d) => d.compression) };

  // 1. drop a controller/graph from a previous export of this tool
  for (const o of objects) {
    if (o.name === CONTROLLER_NAME && o.graphBinding != null && o.children.length === 0) {
      removeEntry(doc, o.entry);
      const g = doc.entries.find((e) => e.kind === 'graph' && e.guid === o.graphBinding);
      if (g) removeEntry(doc, g);
    }
  }
  for (const g of doc.entries.filter((e) => e.kind === 'graph' && e.name === GRAPH_NAME)) removeEntry(doc, g);

  // 2. names + placement (frame-0 pose of the initial animation, turned by its output
  //    rotation) of every imported object
  for (const node of objectNodes) {
    const entry = entryByGuid.get(node.guid);
    if (entry.name !== node.name) setObjectName(entry, node.name);
    const w = rest.get(node.id);
    const pos = displayToGamePos(w.pos);
    const rot = displayQuatToGameEuler(w.rot);
    const clean = (v) => (Math.abs(v) < 1e-7 ? 0 : v);
    const z = node.zoom || [1, 1, 1];
    setObjectTransform(entry, { x: clean(pos.x), y: clean(pos.y), z: clean(pos.z) }, { x: clean(rot.x), y: clean(rot.y), z: clean(rot.z) }, { x: z[0], y: z[1], z: z[2] });
  }

  // 3. motion devices from the plan
  report.warnings.push(...plan.warnings);
  for (const node of objectNodes) {
    const entry = entryByGuid.get(node.guid);
    if (!participating.has(node.id)) {
      // previously imported devices are regenerated only for participating objects
      if (node.hadMotionDevices) setMotionDevices(entry, []);
      continue;
    }
    const records = [];
    const counts = [];
    slots.forEach((s, i) => {
      const dev = plan.devices.find((d) => d.nodeId === node.id && d.slotIndex === i);
      const restW = rest.get(node.id);
      // Euler continuity along the path, starting from the resting placement's rotation
      let ref = quat.toEulerDeg(restW.rot);
      const points = dev.points.map((p) => { const wp = toWaypoint(p, restW, dev.yaw, frame, pivot, ref); ref = wp.eDisplay; return wp; });
      records.push(motionDeviceFields({ name: slotNames[i], motionType: s.clip.loop ? MOTION_CYCLIC : MOTION_ONE_WAY, points }));
      counts.push(points.length);
      report.devices++;
    });
    makeDynamic(entry);
    setMotionDevices(entry, records);
    report.parts.push({ nodeId: node.id, guid: node.guid, name: node.name, points: counts });
  }
  report.slots = slots.map((s, i) => ({ name: slotNames[i], clip: s.clip.name, loop: s.clip.loop, duration: s.baked.duration }));

  // 4. controller + graph
  if (slots.length && participating.size) {
    const used = allGuids(doc);
    const graphGuid = nextGraphGuid(used);
    const ctrlGuid = nextObjectGuid(used, objects.map((o) => o.guid));
    const partGuids = objectNodes.filter((n) => participating.has(n.id)).map((n) => n.guid);
    const initial = initialSlotIndex(project);
    const ctrl = buildControllerEntry({ guid: ctrlGuid, graphGuid, partGuids, changeAnimDefault: '' });
    const graph = buildGraphEntry({ guid: graphGuid, initialAnimation: slotNames[initial], switching: project.exportConfig.switching !== false });
    insertEntry(doc, ctrl, lastEntryOfKind(doc, 'object'));
    insertEntry(doc, graph, null);
    report.controller = { guid: ctrlGuid, graphGuid, initial: slotNames[initial] };
  }

  const bytes = serializeGia(doc);
  return { bytes, report };
}
