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
export function toWaypoint(point, placement, yawDeg, frame, pivot = [0, 0, 0]) {
  const w = yawDeg ? rotateAboutPivot(point, outputRotation(yawDeg), pivot) : point;
  let delta = v3.sub(w.pos, placement.pos);
  if (frame === 'local') delta = quat.rotate(quat.conj(placement.rot), delta);
  const dg = displayToGamePos(delta);
  const rotE = displayQuatToGameEuler(w.rot);
  const clean = (v) => (Math.abs(v) < 1e-7 ? 0 : v);
  return {
    pos: { x: clean(dg.x), y: clean(dg.y), z: clean(dg.z) },
    rot: { x: clean(rotE.x), y: clean(rotE.y), z: clean(rotE.z) },
    duration: Math.max(MIN_POINT_DURATION, point.duration),
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

export function exportGia(project, giaBytes) {
  const doc = parseGia(giaBytes);
  const report = { warnings: [], parts: [], slots: [], devices: 0 };
  const objects = collectObjects(doc);
  const entryByGuid = new Map(objects.map((o) => [o.guid, o.entry]));

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
  const rest = exportPlacement(project);
  const objectNodes = project.nodes.filter((n) => n.type === 'object' && n.guid != null && entryByGuid.has(n.guid));
  for (const node of objectNodes) {
    const entry = entryByGuid.get(node.guid);
    if (entry.name !== node.name) setObjectName(entry, node.name);
    const w = rest.get(node.id);
    const pos = displayToGamePos(w.pos);
    const rot = displayQuatToGameEuler(w.rot);
    const clean = (v) => (Math.abs(v) < 1e-7 ? 0 : v);
    setObjectTransform(entry, { x: clean(pos.x), y: clean(pos.y), z: clean(pos.z) }, { x: clean(rot.x), y: clean(rot.y), z: clean(rot.z) });
  }

  // 3. bake animations
  const { slots, warnings } = bakeAll(project);
  report.warnings.push(...warnings);
  const frame = project.settings.relativeFrame || 'world';
  const pivot = exportPivot(project);
  // a slot whose output rotation differs from the resting arrangement moves every
  // object of the model, so all of them need a device record even when static
  const refYaw = referenceYaw(project);
  const anyRotated = slots.some((s) => yawOf(s.slot) !== refYaw);
  const participating = new Set();
  for (const s of slots) for (const node of objectNodes) if (anyRotated || s.baked.points.get(node.id)?.moves) participating.add(node.id);
  const tol = PRECISION[project.exportConfig.precision || 'normal'] || PRECISION.normal;

  const slotNames = slots.map((s) => s.slot.name || s.clip.name);
  for (const node of objectNodes) {
    const entry = entryByGuid.get(node.guid);
    if (!participating.has(node.id)) {
      // previously imported devices are regenerated only for participating objects
      if (node.hadMotionDevices) setMotionDevices(entry, []);
      continue;
    }
    const records = [];
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
      const src = b && b.moves ? b.points.filter((p) => !p.snap) : [];
      if (startsOff || !src.length) src.unshift({ t: 0, pos: w0.pos, rot: w0.rot, duration: MIN_POINT_DURATION, snap: true });
      const points = src.map((p) => toWaypoint(p, restW, yaw, frame, pivot));
      records.push(motionDeviceFields({ name: slotNames[i], motionType: s.clip.loop ? MOTION_CYCLIC : MOTION_ONE_WAY, points }));
      report.devices++;
    });
    makeDynamic(entry);
    setMotionDevices(entry, records);
    report.parts.push({ nodeId: node.id, guid: node.guid, name: node.name, points: slots.map((s) => s.baked.points.get(node.id)?.points?.length || 1) });
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
